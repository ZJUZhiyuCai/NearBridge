import Foundation
import CoreBluetooth
import Network

// BLE transports only the existing TLS stream to the phone endpoint, never the
// loopback admin API. The peer must still pass certificate pinning and pairing.
final class BluetoothBridge: NSObject, CBPeripheralManagerDelegate {
    static let serviceID = "b4525100-17b0-4cb4-96a6-06c73a620c31"
    private let receiveID = CBUUID(string: "b4525101-17b0-4cb4-96a6-06c73a620c31")
    private let transmitID = CBUUID(string: "b4525102-17b0-4cb4-96a6-06c73a620c31")
    var onStatus: ((String, Bool) -> Void)?
    var onSystemFailure: (() -> Void)?
    private var manager: CBPeripheralManager?
    private var transmitter: CBMutableCharacteristic?
    private var central: CBCentral?
    private var requested = false
    private var publishing = false
    private var pipes: [UInt8: BluetoothPipe] = [:]
    private var pending: [BluetoothFrame] = []
    private var pendingBytes = 0
    private var draining = false
    private var receivedBytes = 0
    private var sentBytes = 0
    private var lastReport = Date.distantPast

    func start() {
        requested = true
        onStatus?(CBManager.authorization == .notDetermined ? "等待 macOS 允许使用蓝牙，请查看系统提示" : "正在开启蓝牙…", true)
        if manager == nil {
            manager = CBPeripheralManager(delegate: self, queue: .main,
                options: [CBPeripheralManagerOptionShowPowerAlertKey: false])
        } else { publish() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in
            guard let self, self.requested, self.manager?.state == .unknown else { return }
            self.onStatus?(CBManager.authorization == .notDetermined
                ? "等待 macOS 允许使用蓝牙，请查看系统提示"
                : "蓝牙仍在等待系统响应，可稍后关闭再开启", true)
        }
    }
    private func publish() {
        guard requested, let manager else { return }
        guard manager.state == .poweredOn else {
            if manager.state == .unauthorized { onStatus?("请在系统设置中允许 NearBridge 使用蓝牙", true) }
            else if manager.state == .poweredOff { onStatus?("请打开 Mac 蓝牙", true) }
            return
        }
        guard !publishing else { return }
        publishing = true
        manager.removeAllServices()
        let rx = CBMutableCharacteristic(type: receiveID, properties: [.write], value: nil, permissions: [.writeable])
        let tx = CBMutableCharacteristic(type: transmitID, properties: [.indicate], value: nil, permissions: [])
        let service = CBMutableService(type: CBUUID(string: Self.serviceID), primary: true)
        service.characteristics = [rx, tx]
        transmitter = tx
        manager.add(service)
    }
    func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        if peripheral.state != .poweredOn {
            publishing = false; resetLink()
        }
        if requested && peripheral.state == .resetting {
            requested = false
            onStatus?("系统蓝牙连接异常 · 已停止重连，请稍后重试", false)
            onSystemFailure?()
            return
        }
        publish()
    }
    func peripheralManager(_ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?) {
        guard requested else { return }
        if let error { publishing = false; onStatus?("蓝牙启动失败：\(error.localizedDescription)", true); return }
        peripheral.startAdvertising([CBAdvertisementDataServiceUUIDsKey: [CBUUID(string: Self.serviceID)],
            CBAdvertisementDataLocalNameKey: "NearBridge Mac"])
    }
    func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
        guard requested else { return }
        if let error { onStatus?("蓝牙广播失败：\(error.localizedDescription)", true) }
        else { onStatus?("蓝牙已就绪 · 等待手机连接", true); NSLog("NearBridge BLE advertising ready") }
    }
    func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didSubscribeTo characteristic: CBCharacteristic) {
        guard requested, characteristic.uuid == transmitID else { return }
        guard self.central == nil || self.central?.identifier == central.identifier else { return }
        self.central = central
        NSLog("NearBridge BLE subscribed; packet limit=%d", central.maximumUpdateValueLength)
        onStatus?("蓝牙通道已连接 · 正在验证设备", true)
        drain()
    }
    func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didUnsubscribeFrom characteristic: CBCharacteristic) {
        guard self.central?.identifier == central.identifier else { return }
        resetLink()
        if requested { onStatus?("蓝牙已就绪 · 等待手机连接", true) }
    }
    func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
        guard let first = requests.first else { return }
        // Validate the whole write transaction before forwarding any byte.
        for request in requests {
            guard requested, request.central.identifier == central?.identifier,
                  request.characteristic.uuid == receiveID,
                  let value = request.value, BluetoothWire.validWrite(value, offset: request.offset) else {
                peripheral.respond(to: first, withResult: .requestNotSupported); return
            }
        }
        for request in requests {
            let value = request.value!
            let type = value[0], id = value[1]
            if type == 1 {
                guard pipes[id] == nil, pipes.count < 4 else { send(type: 4, id: id); continue }
                let pipe = BluetoothPipe(send: { [weak self] type, data, completion in
                    self?.send(type: type, id: id, payload: data, completion: completion)
                }, finished: { [weak self] in self?.pipes.removeValue(forKey: id) })
                pipes[id] = pipe; pipe.start()
            } else if type == 3 {
                let payload = Data(value.dropFirst(2))
                receivedBytes += payload.count; reportTraffic()
                if let pipe = pipes[id] { pipe.receive(payload) } else { send(type: 4, id: id) }
            } else { pipes[id]?.close(notify: false) }
        }
        peripheral.respond(to: first, withResult: .success)
    }
    private func send(type: UInt8, id: UInt8, payload: Data = Data(), completion: ((Bool) -> Void)? = nil) {
        guard let central, transmitter != nil else { completion?(false); return }
        guard let frames = BluetoothWire.frames(type: type, id: id, payload: payload, limit: central.maximumUpdateValueLength),
              pendingBytes + payload.count + frames.count * 2 <= 512 * 1024 else { completion?(false); return }
        for (index, bytes) in frames.enumerated() {
            pending.append(BluetoothFrame(bytes: bytes, completion: index == frames.count - 1 ? completion : nil))
            pendingBytes += bytes.count
        }
        drain()
    }
    private func drain() {
        guard !draining, let manager, let central, let transmitter else { return }
        draining = true
        defer { draining = false }
        while let frame = pending.first {
            guard manager.updateValue(frame.bytes, for: transmitter, onSubscribedCentrals: [central]) else { return }
            pending.removeFirst(); pendingBytes -= frame.bytes.count
            if frame.bytes[0] == 3 { sentBytes += frame.bytes.count - 2; reportTraffic() }
            if let completion = frame.completion { DispatchQueue.main.async { completion(true) } }
        }
    }
    func peripheralManagerIsReady(toUpdateSubscribers peripheral: CBPeripheralManager) { drain() }
    private func reportTraffic() {
        guard Date().timeIntervalSince(lastReport) > 0.5 else { return }
        lastReport = Date()
        let rx = ByteCountFormatter.string(fromByteCount: Int64(receivedBytes), countStyle: .file)
        let tx = ByteCountFormatter.string(fromByteCount: Int64(sentBytes), countStyle: .file)
        onStatus?("蓝牙直传 · 已收 \(rx) · 已发 \(tx)", true)
    }
    private func resetLink() {
        central = nil
        let active = Array(pipes.values); pipes.removeAll()
        active.forEach { $0.close(notify: false) }
        let queued = pending; pending.removeAll(); pendingBytes = 0
        queued.forEach { $0.completion?(false) }
    }
    func stop() {
        requested = false
        manager?.stopAdvertising(); manager?.removeAllServices()
        publishing = false; resetLink(); transmitter = nil
        onStatus?("蓝牙未开启", false)
    }
}

private struct BluetoothFrame {
    let bytes: Data
    let completion: ((Bool) -> Void)?
}

private final class BluetoothPipe {
    private let tcp = NWConnection(host: "127.0.0.1", port: 53320, using: .tcp)
    private let send: (UInt8, Data, ((Bool) -> Void)?) -> Void
    private let finished: () -> Void
    private var closed = false
    private var ready = false
    private var pendingBytes = 0
    private var idle: Timer?
    init(send: @escaping (UInt8, Data, ((Bool) -> Void)?) -> Void, finished: @escaping () -> Void) {
        self.send = send; self.finished = finished
    }
    func start() {
        touch()
        tcp.stateUpdateHandler = { [weak self] state in
            guard let self, !self.closed else { return }
            switch state {
            case .ready:
                self.ready = true
                self.send(2, Data()) { [weak self] ok in
                    if ok { self?.read() } else { self?.close() }
                }
            case .failed, .cancelled: self.close()
            default: break
            }
        }
        tcp.start(queue: .main)
    }
    private func touch() {
        idle?.invalidate()
        idle = Timer.scheduledTimer(withTimeInterval: 120, repeats: false) { [weak self] _ in self?.close() }
    }
    func receive(_ data: Data) {
        guard ready, !closed, pendingBytes + data.count <= 512 * 1024 else { close(); return }
        touch(); pendingBytes += data.count
        tcp.send(content: data, completion: .contentProcessed { [weak self] error in
            guard let self else { return }
            self.pendingBytes -= data.count
            if error != nil { self.close() }
        })
    }
    private func read() {
        guard !closed else { return }
        tcp.receive(minimumIncompleteLength: 1, maximumLength: 4096) { [weak self] data, _, complete, error in
            guard let self, !self.closed else { return }
            if let data, !data.isEmpty {
                self.touch()
                self.send(3, data) { [weak self] ok in
                    if ok && !complete && error == nil { self?.read() } else { self?.close() }
                }
            } else if complete || error != nil { self.close() }
            else { self.read() }
        }
    }
    func close(notify: Bool = true) {
        guard !closed else { return }
        closed = true; idle?.invalidate(); idle = nil; tcp.cancel()
        if notify { send(4, Data(), nil) }
        finished()
    }
}
