import Foundation

@main struct BluetoothProtocolTests {
    static func main() {
        // Known protocol vectors, including wrong-direction and malformed frames.
        precondition(BluetoothWire.validWrite(Data([1, 7])))
        precondition(BluetoothWire.validWrite(Data([3, 255, 0, 255, 128])))
        precondition(BluetoothWire.validWrite(Data([4, 7])))
        for packet in [Data(), Data([1]), Data([1, 0]), Data([1, 7, 9]), Data([2, 7]),
                       Data([3, 7]), Data([4, 7, 9]), Data([255, 7]), Data(repeating: 3, count: 513)] {
            precondition(!BluetoothWire.validWrite(packet))
        }
        precondition(!BluetoothWire.validWrite(Data([1, 7]), offset: 1))
        precondition(BluetoothWire.frames(type: 2, id: 7, payload: Data(), limit: 20) == [Data([2, 7])])
        precondition(BluetoothWire.frames(type: 1, id: 0, payload: Data(), limit: 20) == nil)
        precondition(BluetoothWire.frames(type: 1, id: 7, payload: Data([1]), limit: 20) == nil)
        let payload = Data((0..<65537).map { UInt8(truncatingIfNeeded: $0 * 31) })
        // Default ATT MTU, negotiated MTUs, and an invalid overlarge peer limit.
        for limit in [20, 182, 244, 512, 1024] {
            let packets = BluetoothWire.frames(type: 3, id: 19, payload: payload, limit: limit)!
            precondition(packets.allSatisfy { $0.count <= min(limit, 512) && BluetoothWire.validWrite($0) && $0[1] == 19 })
            let restored = packets.reduce(into: Data()) { $0.append($1.dropFirst(2)) }
            precondition(restored == payload)
        }
        print("Bluetooth wire vectors, malformed writes and MTU fragmentation passed")
    }
}
