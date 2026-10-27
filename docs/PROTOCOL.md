# Protocol contracts

Since 0.7, Windows is the primary desktop. Existing mac role/source values and /api/mac/* endpoints mean the trusted desktop, including Windows; they remain unchanged for stored records and older clients. BLE UUIDs, frames, CA/pin verification and receipts are unchanged. The native pairing endpoint accepts an optional ip query selecting a current local address. /api/mac/reveal-file accepts only a stored file ID and opens its parent directory; phone callers cannot use it.

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

## Reliable text and workflows (0.6)

`GET /api/state` advertises `capabilities.reliableActions: 1`. Native clients use new routes, so an older server returns an error instead of silently ignoring idempotency fields:

- `POST /api/actions/text`: `{ requestId, requestedAt, text }`.
- `POST /api/actions/workflows/:id/run`: `{ requestId, requestedAt }`.
- Mac requests additionally carry `peerId` (current paired ID, or `null` before pairing). An unaccepted request bound to another phone is rejected. Already accepted Mac requests may still retrieve their receipt after pairing changes.

`requestId` is 16–80 ASCII letters/digits/hyphens; clients generate UUIDs. `requestedAt` is the original integer Unix time in milliseconds. Preserve **both** values for all retries. More than five minutes in the future is rejected; requests seven days old return 410 and never execute, even after their receipt was pruned.

The server stores at most 4096 live receipts, scoped by phone identity or local Mac role. Each binds kind, content hash, original timestamp and resulting item/job ID. Live receipts are never evicted for capacity: new requests fail with 507, while existing IDs can still be acknowledged. Receipt and text/job are committed together, with file fsync before index replacement, before a workflow starts. Persistence failure rolls back memory and prevents execution. The private ledger is not sent in the history feed.

Replays return the original item/job without copying text or executing the workflow again. Deleting text or trimming the 100-job history does not remove its receipt: deleted text returns `{ accepted: true, replayed: true, item: null }`; a trimmed job returns `status: accepted`, indicating prior acceptance, not proof of successful completion. Restarted running jobs become `interrupted` and never auto-execute again.

Both native clients persist one pending operation before POST. A lost reply keeps its ID across restart; users can explicitly retry or inspect the result and end retries. Startup and network recovery do **not** replay workflows. Phone journals are bound to a local pairing scope; a new QR pairing cannot inherit an ambiguous action. Corrupt journals block sends until the user checks the result and ends that retry. Ending a retry does not undo its effects.

Old `/api/items` and `/api/workflows/:id/run` remain compatible. Legacy text has no deduplication; legacy workflow IDs deduplicate only while their job is retained. New native clients require the reliable capability for text/workflows. File UUID retries retain their existing protocol. All workflows remain serialized and allowlisted on Mac; no remote shell text or shortcut arguments are accepted.

## Connection selection (0.6)

Phone settings separate the chosen mode (`auto`, `bt`, `lan`) from the actual transport. Upgrading preserves an existing explicit mode; a new pairing defaults to automatic. “Only Bluetooth” never falls back to LAN, and “Only LAN” never touches BLE.

Automatic mode makes an anonymous LAN bootstrap probe with the QR CA and SPKI pin (1.5-second connect/read timeouts); credentials stay off discovery probes. It uses the verified LAN endpoint if reachable, otherwise the selected BLE peer. When idle on BLE it can probe LAN again after at least 30 seconds, between synchronization requests. Active HTTP requests, actions and file transfers block route changes. A failed mutation is never automatically submitted on another route. mDNS offers untrusted candidate addresses; pinned TLS validation remains mandatory.

## BLE transport

Service UUID `b4525100-17b0-4cb4-96a6-06c73a620c31`; RX `...5101...`, TX `...5102...`. Frames contain type, nonzero stream ID, payload. Types: 1 open, 2 opened, 3 data, 4 close. At most four TLS streams, 512 KiB bounded buffers, and a 120-second idle limit. Use acknowledged writes and indications; respect negotiated MTU and backpressure.

This transports the original pinned TLS connection. It does not bypass authentication or expose the Mac admin listener. Bluetooth-only mode has no LAN fallback. Remembered peers connect directly, with discovery on failure. The first two failed rounds cool down for 2/4 seconds; three consecutive failed rounds pause until explicit retry. A link stable for 30 seconds resets this failure history on its next failure. See [BLE implementation and hardware evidence](BLUETOOTH.md).
