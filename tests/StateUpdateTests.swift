import Foundation

@main struct StateUpdateTests {
    static func main() throws {
        let a: [String: Any] = ["id": "a", "kind": "text", "source": "mac", "createdAt": "test", "text": "keep"]
        let b: [String: Any] = ["id": "b", "kind": "text", "source": "mac", "createdAt": "test", "text": "remove"]
        let c: [String: Any] = ["id": "c", "kind": "text", "source": "mac", "createdAt": "test", "text": "new"]
        func state(_ revision: String, _ items: [[String: Any]]) -> [String: Any] {
            ["revision": revision, "name": "Mac", "version": "test", "paired": true, "items": items, "workflows": [], "jobs": []]
        }
        func decode<T: Decodable>(_ json: [String: Any], _ type: T.Type) throws -> T {
            try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: json))
        }
        let previous = try decode(state("boot.1", [a, b]), BridgeState.self)
        let delta: [String: Any] = ["baseRevision": "boot.1", "state": state("boot.3", [c]), "removed": ["b"], "order": ["c", "a"]]
        let update = try decode(["revision": "boot.3", "delta": delta], StateUpdate.self)
        let next = try update.resolving(previous)!
        precondition(next.items.map(\.id) == ["c", "a"] && next.items[1].text == "keep")
        let late = try decode(["revision": "boot.2", "delta": delta], StateUpdate.self)
        let ignored = try late.resolving(next)
        precondition(ignored == nil)
        let heartbeat = try decode(["revision": "boot.3"], StateUpdate.self)
        let idle = try heartbeat.resolving(next)
        precondition(idle == nil)
        var received = a; received["receivedAt"] = "now"
        let receipt = try decode(["revision": "boot.4", "delta": ["baseRevision": "boot.3", "state": state("boot.4", [received]), "removed": []]], StateUpdate.self)
        let final = try receipt.resolving(next)!
        precondition(final.items.map(\.id) == ["c", "a"] && final.items[1].receivedAt == "now")
        for bad: [String: Any] in [
            ["baseRevision": "wrong", "state": state("boot.5", []), "removed": []],
            ["baseRevision": "boot.4", "state": state("boot.5", []), "removed": [], "order": ["c", "c"]],
            ["baseRevision": "boot.4", "state": state("boot.5", []), "removed": [], "order": ["missing", "a"]],
            ["baseRevision": "boot.4", "state": state("boot.5", []), "removed": ["missing"]]
        ] {
            let invalid = try decode(["revision": "boot.5", "delta": bad], StateUpdate.self)
            var rejected = false
            do { _ = try invalid.resolving(final) } catch { rejected = true }
            precondition(rejected)
        }
        print("Native snapshot/delta merge, order, deletion, receipt and recovery vectors passed")
    }
}
