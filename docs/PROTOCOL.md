# Protocol contracts

This documents the current local protocol, not a stable third-party API. Keep old `/api/state` clients working when adding fields.

## Endpoints and identity

| Endpoint | Purpose |
| --- | --- |
| `127.0.0.1:53318` HTTP | Mac administration; bound only to loopback |
| `*:53319` HTTPS | Legacy browser client |
| `*:53320` HTTPS | Native phone; private CA plus pinned SPKI SHA-256 |

API clients send `X-NearBridge: 1`; download and browser SSE routes have narrowly scoped exceptions. Phone requests require the paired Bearer session or browser cookie. Host and Origin must match the actual listener; cross-site browser requests are rejected. mDNS only offers candidate LAN addresses.

Native QR version 2 includes `protocol`, `version`, `name`, `url`, one-use `token`, DER CA `certificate` in base64, and `publicKeyHash`. The QR expires after five minutes. `/api/pair` returns a claim; the Mac approves or rejects it; `/api/pair/status` requires `X-Pair-Claim`. Native migration retains the device ID and replaces the session. Sessions expire after 30 days.

## State and changes

`GET /api/state` returns the role-filtered snapshot, including `revision`. A revision has the form `<server-epoch>.<sequence>` and is not a credential. A server restart creates a new epoch.

```http
GET /api/changes?since=<revision>&wait=25000
X-NearBridge: 1
Authorization: Bearer <session>
```

Changed response: `{ "revision": "...", "state": { ... } }`.
Idle response: `{ "revision": "..." }`.

Missing or different revisions get a current snapshot immediately. `wait` accepts integer milliseconds from 1 to 25000. Changed snapshots retain the same role filtering as `/api/state`; idle replies never clear the client's history. A revoked/expired original credential returns 401 instead of a snapshot. At most eight held observers per role are allowed across SSE and changes, and disconnected observers are removed.

Sequence comparison applies only within the same server epoch. SSE `/api/events` remains available to the browser. Notifications carry no user data; the browser obtains a fresh authorized snapshot.

### Optional item deltas (0.5)

Append `&mode=delta-v1` to `/api/changes`. Older servers ignore the option and return their normal snapshot. The response is either the existing full/idle shape or:

```json
{
  "revision": "epoch.12",
  "delta": {
    "baseRevision": "epoch.10",
    "state": { "revision": "epoch.12", "items": [], "name": "Mac", "workflows": [], "jobs": [] },
    "removed": [],
    "order": ["item-id"]
  }
}
```

The example abbreviates `state` metadata. `delta.state` has the full current role-filtered metadata, but its `items` contains only new/changed items. Remove `removed` IDs, upsert changed items, then apply `order` when present; an omitted order retains the previous order. Validate the base revision, matching target revision, unique complete order and all referenced items **before** replacing visible state. Ignore already-applied/older same-epoch responses. On a mismatched or malformed delta, fetch `/api/state`; never partially apply it.

Baselines are scoped by role and the current credential, with at most 32 ID/hash manifests per role. Unknown/evicted baselines and deltas larger than a snapshot return a full snapshot. Revoked credentials are rejected before constructing either response. No history bodies are retained in old baseline manifests. The history window is bounded by both 200 items and 8 MiB of encoded item JSON; individual text is never truncated. Window eviction/removal may reveal older items, which appear as ordinary upserts.

## Files

- `POST /api/transfers`: `{ id: UUID, name, size }` reserves a transfer or returns its current offset / completed item.
- `PUT /api/transfers/:id?offset=n`: binary bytes, exact `Content-Length`, maximum 4 MiB per request. BLE native clients use 64 KiB chunks.
- `POST /api/transfers/:id/complete`: checks full length, hashes data, commits once.
- `DELETE /api/transfers/:id`: cancels when no chunk is busy.
- `GET /api/files/:id`: authorized file download; supports one explicit byte range.
- `POST /api/items/:id/received`: phone-only acknowledgement with the verified `sha256` for files.

Limits: 512 MiB per file, 2 GiB stored/reserved files, 1000 items including pending reservations, 100 pending resumable transfers, at most three active resumable chunk/hash operations. The state snapshot exposes up to 200 newest accessible items within the encoded history budget. Text is limited to 64 KiB UTF-8; JSON request bodies are also bounded.

Only the source role and paired device can access its in-progress transfer. Revocation removes that phone's unfinished uploads. A completed UUID cannot be reused with a different filename or size. Filename normalization removes path separators/control characters and reserves byte space for collision suffixes.

Chunks use asynchronous file writes and fsync, with authorization rechecked before advancing persisted offsets. Repeating an already valid receipt is a no-op (the SHA-256 is still checked). Active downloads are aborted when authorization is revoked/rotated and within the one-second expiry sweep; bytes already sent may still be in flight.

## Workflows and retries

`POST /api/workflows/:id/run` accepts a client-generated `requestId`. Reusing the same ID for the same role/device/workflow returns the original job; changing the workflow with that ID is rejected. Jobs are serialized. The Mac must have enabled the workflow. Phone-provided shell text or shortcut arguments are never accepted.

Do not blindly retry an ambiguous action with a new ID: a network failure does not prove the original action did not execute. File UUID retries are idempotent. Text sends currently lack durable request-ID deduplication; inspect the feed before retrying an ambiguous send.

## BLE transport

Service UUID `b4525100-17b0-4cb4-96a6-06c73a620c31`; RX `...5101...`, TX `...5102...`. Frames contain type, nonzero stream ID, payload. Types: 1 open, 2 opened, 3 data, 4 close. At most four TLS streams, 512 KiB bounded buffers, and a 120-second idle limit. Use acknowledged writes and indications; respect negotiated MTU and backpressure.

This transports the original pinned TLS connection. It does not bypass authentication or expose the Mac admin listener. BLE mode has no silent LAN fallback. See [BLE implementation and hardware evidence](BLUETOOTH.md).
