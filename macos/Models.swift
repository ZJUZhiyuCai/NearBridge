import Foundation

struct Device: Decodable { let id: String; let name: String; let connected: Bool }
struct BridgeItem: Decodable, Identifiable {
    let id: String; let kind: String; let source: String; let createdAt: String
    let name: String?; let text: String?; let size: Int64?; let localPath: String?; let receivedAt: String?
}
struct Workflow: Decodable, Identifiable {
    let id: String; let name: String; let description: String; let enabled: Bool
}
struct WorkflowJob: Decodable, Identifiable {
    let id: String; let name: String; let status: String; let message: String?
}
struct PairRequest: Decodable { let id: String; let name: String }
struct BridgeSettings: Decodable { let copyIncomingText: Bool }
struct BridgeState: Decodable {
    let revision: String?
    let name: String; let version: String; let paired: Bool; let device: Device?
    var items: [BridgeItem]; let workflows: [Workflow]; let jobs: [WorkflowJob]
    let pending: PairRequest?; let settings: BridgeSettings?; let inbox: String?
}
struct StateDelta: Decodable {
    let baseRevision: String; let state: BridgeState; let removed: [String]; let order: [String]?
}
struct StateUpdate: Decodable {
    let revision: String; let state: BridgeState?; let delta: StateDelta?
    func resolving(_ previous: BridgeState?) throws -> BridgeState? {
        if let state { return state }
        guard let delta else { return nil }
        if revision == previous?.revision { return nil }
        if let before = previous?.revision?.split(separator: "."), before.count == 2 {
            let after = revision.split(separator: ".")
            if after.count == 2, before[0] == after[0], let old = Int(before[1]), let new = Int(after[1]), new < old { return nil }
        }
        guard let previous, delta.baseRevision == previous.revision, delta.state.revision == revision else {
            throw BridgeError(message: "同步基线已改变，正在重新获取状态")
        }
        var items = [String: BridgeItem]()
        for item in previous.items { items[item.id] = item }
        for id in delta.removed {
            guard items.removeValue(forKey: id) != nil else { throw BridgeError(message: "同步删除记录无效") }
        }
        var changed = Set<String>()
        let removed = Set(delta.removed)
        for item in delta.state.items {
            guard changed.insert(item.id).inserted, !removed.contains(item.id) else { throw BridgeError(message: "同步记录重复") }
            items[item.id] = item
        }
        let order = delta.order ?? previous.items.map(\.id)
        guard order.count <= 200, order.count == items.count, Set(order).count == order.count else {
            throw BridgeError(message: "同步顺序不完整")
        }
        var next = delta.state
        next.items = try order.map { id in
            guard let item = items[id] else { throw BridgeError(message: "同步记录缺失") }
            return item
        }
        return next
    }
}
struct PairingInfo: Decodable { let qr: String?; let url: String?; let fingerprint: String; let expiresAt: Double }
struct ShortcutInfo: Decodable, Identifiable { let id: String; let name: String }
struct ShortcutList: Decodable { let shortcuts: [ShortcutInfo] }
struct TransferReply: Decodable { let id: String; let offset: Int64; let size: Int64; let chunkSize: Int; let item: BridgeItem? }
struct QueuedFile: Codable, Identifiable {
    var id = UUID().uuidString.lowercased()
    var path: String
    var name: String
    var size: Int64
    var modified: Double
    var offset: Int64 = 0
    var phase = "queued"
    var error: String? = nil
    var temporary = false
    var progress: Double { size == 0 ? 0 : Double(offset) / Double(size) }
}
struct BridgeError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}
func byteString(_ size: Int64) -> String { ByteCountFormatter.string(fromByteCount: size, countStyle: .file) }

enum BridgeAPI {
    static let base = URL(string: "http://127.0.0.1:53318")!
    static func request(_ route: String, method: String = "GET", body: [String: Any]? = nil, raw: Data? = nil) async throws -> Data {
        var request = URLRequest(url: URL(string: route, relativeTo: base)!)
        request.httpMethod = method
        request.timeoutInterval = 60
        request.setValue("1", forHTTPHeaderField: "X-NearBridge")
        if let body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        } else if let raw {
            request.httpBody = raw
            request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else {
            let error = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            throw BridgeError(message: error?["error"] as? String ?? "连接未完成，请稍后重试。")
        }
        return data
    }
    static func get<T: Decodable>(_ route: String, as type: T.Type) async throws -> T {
        try JSONDecoder().decode(type, from: await request(route))
    }
}
