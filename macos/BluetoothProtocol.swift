import Foundation

// Protocol v1: one type byte, one nonzero stream ID, followed by TLS bytes.
// GATT writes and indications preserve packet boundaries and order.
enum BluetoothWire {
    static func validWrite(_ bytes: Data, offset: Int = 0) -> Bool {
        guard offset == 0, bytes.count >= 2, bytes.count <= 512, bytes[1] != 0 else { return false }
        switch bytes[0] {
        case 1, 4: return bytes.count == 2
        case 3: return bytes.count > 2
        default: return false
        }
    }
    static func frames(type: UInt8, id: UInt8, payload: Data, limit: Int) -> [Data]? {
        guard id > 0, limit >= 3, [UInt8(1), 2, 3, 4].contains(type),
              type == 3 || payload.isEmpty else { return nil }
        let size = min(512, limit) - 2
        if payload.isEmpty { return type == 3 ? nil : [Data([type, id])] }
        var result: [Data] = []
        for start in stride(from: 0, to: payload.count, by: size) {
            var frame = Data([type, id])
            frame.append(payload.subdata(in: start..<min(payload.count, start + size)))
            result.append(frame)
        }
        return result
    }
}
