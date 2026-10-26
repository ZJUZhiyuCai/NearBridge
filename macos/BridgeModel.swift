import AppKit
import SwiftUI
import UniformTypeIdentifiers

@MainActor final class BridgeModel: ObservableObject {
    @Published var state: BridgeState?
    @Published var connection = "正在连接 Mac 服务…"
    @Published var serviceAvailable = false
    @Published var error: String?
    @Published var notice: String?
    @Published var tab = "transfer"
    @Published var draft = ""
    @Published var pairing: PairingInfo?
    @Published var webPairingInfo: PairingInfo?
    @Published var shortcuts: [ShortcutInfo] = []
    @Published var showingShortcuts = false
    @Published var showingNativePairing = false
    @Published var queue: [QueuedFile] = []
    @Published var packing = false
    @Published var busy = false
    @Published var bluetoothStatus = "蓝牙未开启"
    @Published var bluetoothEnabled = false
    private let bluetooth = BluetoothBridge()
    var onChange: (() -> Void)?
    private var polling: Task<Void, Never>?
    private var worker: Task<Void, Never>?
    private let dataDirectory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/NearBridge")
    private var queueFile: URL { dataDirectory.appendingPathComponent("native-queue.json") }

    func start() {
        bluetooth.onStatus = { [weak self] status, enabled in
            self?.bluetoothStatus = status; self?.bluetoothEnabled = enabled
        }
        bluetooth.onSystemFailure = { UserDefaults.standard.set(false, forKey: "nearbridgeBluetoothEnabled") }
        if UserDefaults.standard.bool(forKey: "nearbridgeBluetoothEnabled") { bluetooth.start() }
        if let data = try? Data(contentsOf: queueFile), let saved = try? JSONDecoder().decode([QueuedFile].self, from: data) {
            queue = saved.filter { $0.phase != "done" }
            for index in queue.indices { queue[index].phase = "paused"; queue[index].error = "已保留进度，点继续发送" }
        }
        polling = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }
    func stop() { polling?.cancel(); worker?.cancel(); bluetooth.stop(); persist() }
    func toggleBluetooth() {
        if bluetoothEnabled { bluetooth.stop() } else { bluetooth.start() }
        UserDefaults.standard.set(bluetoothEnabled, forKey: "nearbridgeBluetoothEnabled")
    }
    func refresh() async {
        do {
            state = try await BridgeAPI.get("/api/state", as: BridgeState.self)
            serviceAvailable = true
            connection = state?.device?.connected == true ? "手机已连接" : (state?.paired == true ? "手机离线 · 文件将等待接收" : "配对后开始互传")
            onChange?()
        } catch { serviceAvailable = false; connection = "连接服务暂时不可用，正在重连…" }
    }
    @discardableResult
    func action(_ route: String, body: [String: Any] = [:], success: String? = nil) -> Task<Bool, Never> {
        Task {
            do {
                _ = try await BridgeAPI.request(route, method: "POST", body: body)
                if let success { showNotice(success) }
                await refresh()
                return true
            } catch { self.error = error.localizedDescription; return false }
        }
    }
    func showNotice(_ value: String) {
        notice = value
        Task { try? await Task.sleep(for: .seconds(5)); if notice == value { notice = nil } }
    }
    func sendText() {
        let text = draft
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !busy else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                _ = try await BridgeAPI.request("/api/items", method: "POST", body: ["text": text])
                if draft == text { draft = "" }
                showNotice("文字已加入手机收件箱")
                await refresh()
            } catch { self.error = error.localizedDescription }
        }
    }
    func chooseFiles() {
        let panel = NSOpenPanel()
        panel.title = "发送到华为手机"
        panel.prompt = "发送"
        panel.canChooseFiles = true; panel.canChooseDirectories = true; panel.allowsMultipleSelection = true
        panel.begin { response in
            if response == .OK { Task { @MainActor in self.enqueue(panel.urls) } }
        }
    }
    func acceptDrop(_ providers: [NSItemProvider]) -> Bool {
        for provider in providers where provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
            provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, _ in
                let url: URL?
                if let data = item as? Data { url = URL(dataRepresentation: data, relativeTo: nil) }
                else { url = item as? URL }
                if let url, url.isFileURL { Task { @MainActor in self.enqueue([url]) } }
            }
        }
        return true
    }
    func enqueue(_ urls: [URL]) {
        tab = "transfer"
        Task {
            packing = true
            defer { packing = false; runQueue() }
            for url in urls where url.isFileURL {
                do {
                    let queued = try await Task.detached(priority: .userInitiated) { () throws -> QueuedFile in
                        let values = try url.resourceValues(forKeys: [.isDirectoryKey, .isRegularFileKey, .fileSizeKey, .contentModificationDateKey])
                        var target = url, temporary = false
                        if values.isDirectory == true {
                            let directory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/NearBridge/native-archives/\(UUID().uuidString)")
                            let sourcePath = url.resolvingSymlinksInPath().standardizedFileURL.path
                            if sourcePath == "/" || directory.path.hasPrefix(sourcePath + "/") {
                                throw BridgeError(message: "请选择具体子文件夹；这个目录包含 NearBridge 自己的传输暂存区。")
                            }
                            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                            target = directory.appendingPathComponent(url.lastPathComponent + ".zip")
                            let process = Process()
                            process.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
                            process.arguments = ["-c", "-k", "--keepParent", "--sequesterRsrc", url.path, target.path]
                            process.standardError = FileHandle.nullDevice
                            try process.run(); process.waitUntilExit()
                            if process.terminationStatus != 0 { try? FileManager.default.removeItem(at: directory); throw BridgeError(message: "文件夹打包失败，请检查读取权限。") }
                            temporary = true
                        } else if values.isRegularFile != true { throw BridgeError(message: "请选择普通文件或文件夹。") }
                        let attributes = try FileManager.default.attributesOfItem(atPath: target.path)
                        let size = (attributes[.size] as? NSNumber)?.int64Value ?? 0
                        if size > 512 * 1024 * 1024 {
                            if temporary { try? FileManager.default.removeItem(at: target.deletingLastPathComponent()) }
                            throw BridgeError(message: "\(url.lastPathComponent) 超过当前单文件 512 MB 上限。")
                        }
                        return QueuedFile(path: target.path, name: target.lastPathComponent, size: size, modified: (attributes[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0, temporary: temporary)
                    }.value
                    queue.append(queued); persist()
                } catch { self.error = error.localizedDescription }
            }
        }
    }
    private func persist() {
        do {
            try FileManager.default.createDirectory(at: dataDirectory, withIntermediateDirectories: true)
            try JSONEncoder().encode(queue.filter { $0.phase != "done" }).write(to: queueFile, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: queueFile.path)
        } catch { self.error = "无法保存待发队列：\(error.localizedDescription)" }
    }
    private func update(_ id: String, _ block: (inout QueuedFile) -> Void) {
        if let index = queue.firstIndex(where: { $0.id == id }) { block(&queue[index]); persist() }
    }
    private func runQueue() {
        guard worker == nil else { return }
        worker = Task {
            defer { worker = nil }
            while !Task.isCancelled, let item = queue.first(where: { $0.phase == "queued" }) {
                update(item.id) { $0.phase = "sending"; $0.error = nil }
                do {
                    let attrs = try FileManager.default.attributesOfItem(atPath: item.path)
                    guard (attrs[.size] as? NSNumber)?.int64Value == item.size,
                          (attrs[.modificationDate] as? Date)?.timeIntervalSince1970 == item.modified else {
                        throw BridgeError(message: "原文件已改变，请取消后重新选择。")
                    }
                    let result = try await BridgeAPI.request("/api/transfers", method: "POST", body: ["id": item.id, "name": item.name, "size": item.size])
                    let transfer = try JSONDecoder().decode(TransferReply.self, from: result)
                    var offset = transfer.offset
                    if transfer.item == nil {
                        let file = try FileHandle(forReadingFrom: URL(fileURLWithPath: item.path))
                        defer { try? file.close() }
                        while offset < item.size {
                            try Task.checkCancellation()
                            if queue.first(where: { $0.id == item.id })?.phase != "sending" { throw CancellationError() }
                            try file.seek(toOffset: UInt64(offset))
                            let chunk = try file.read(upToCount: min(transfer.chunkSize, Int(item.size - offset))) ?? Data()
                            if chunk.isEmpty { throw BridgeError(message: "原文件读取中断，请重新选择。") }
                            let data = try await BridgeAPI.request("/api/transfers/\(item.id)?offset=\(offset)", method: "PUT", raw: chunk)
                            offset = try JSONDecoder().decode(TransferReply.self, from: data).offset
                            update(item.id) { $0.offset = offset }
                        }
                        if queue.first(where: { $0.id == item.id })?.phase != "sending" { throw CancellationError() }
                        _ = try await BridgeAPI.request("/api/transfers/\(item.id)/complete", method: "POST", body: [:])
                    }
                    update(item.id) { $0.phase = "done" }
                    if item.temporary { try? FileManager.default.removeItem(at: URL(fileURLWithPath: item.path).deletingLastPathComponent()) }
                    await refresh()
                } catch {
                    if queue.first(where: { $0.id == item.id })?.phase == "sending" {
                        update(item.id) { $0.phase = "failed"; $0.error = error.localizedDescription }
                    }
                }
            }
        }
    }
    func pause(_ id: String) { update(id) { $0.phase = "paused"; $0.error = "已暂停，进度保留" } }
    func retry(_ id: String) { update(id) { $0.phase = "queued"; $0.error = nil }; runQueue() }
    func cancel(_ id: String) {
        guard let item = queue.first(where: { $0.id == id }) else { return }
        pause(id)
        Task {
            do {
                _ = try await BridgeAPI.request("/api/transfers/\(id)", method: "DELETE")
            } catch {
                // Never discard a queue entry on an ambiguous server response.
                if !error.localizedDescription.contains("传输不存在") { self.error = error.localizedDescription; return }
            }
            queue.removeAll { $0.id == id }; persist()
            if item.temporary { try? FileManager.default.removeItem(at: URL(fileURLWithPath: item.path).deletingLastPathComponent()) }
        }
    }
    func loadPairing(refresh: Bool = false) {
        Task {
            do {
                if refresh { _ = try await BridgeAPI.request("/api/pairing/refresh", method: "POST", body: [:]) }
                webPairingInfo = try await BridgeAPI.get("/api/pairing", as: PairingInfo.self)
            } catch { self.error = error.localizedDescription }
        }
    }
    func loadShortcuts() {
        Task {
            do { shortcuts = try await BridgeAPI.get("/api/mac/shortcuts", as: ShortcutList.self).shortcuts; showingShortcuts = true }
            catch { self.error = error.localizedDescription }
        }
    }
    func nativePairing() {
        Task {
            do {
                let data = try await BridgeAPI.request("/api/pairing/native", method: "POST", body: [:])
                pairing = try JSONDecoder().decode(PairingInfo.self, from: data)
                showingNativePairing = true
            } catch { self.error = error.localizedDescription }
        }
    }
    func reveal(_ item: BridgeItem) {
        if let path = item.localPath { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)]) }
    }
}
