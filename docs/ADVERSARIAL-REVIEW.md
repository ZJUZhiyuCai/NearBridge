# Adversarial review · 0.4

Review date: 2026-10-26. Scope: local Node service, native client state/transfer lifecycle, BLE framing boundaries, build and repository hygiene. Method: trace trust boundaries, construct failing HTTP/client reproductions, apply fixes, and rerun regressions. This is an internal engineering review, not independent certification.

## Reproduced and fixed

| Finding | Impact / trigger | Fix and evidence |
| --- | --- | --- |
| Session rotation left SSE alive | Native migration retained the device ID, so an old browser credential kept receiving change timing after rotation | Validate the exact original credential during broadcasts/heartbeats; regression opens a real TLS SSE connection and rotates the session through pairing APIs |
| Unbounded observers / slow readers | A client could retain unlimited event responses or accumulate unsent notifications | Eight held observers per role, 64 connections per listener; disconnect on SSE backpressure; regression reaches the cap and verifies capacity is released |
| UTF-8 filename overflow | A long Chinese/emoji filename passed the character limit but exceeded the filesystem byte limit | 240-byte normalized base name, preserved bounded extension, room for collision suffixes; actual uploads verify two distinct valid files |
| QR expiry checked before body arrival | A slow body could complete after expiry using an earlier timestamp | Re-evaluate time after reading JSON; regression completes an in-flight body after advancing the clock |
| Clipboard-send quota race | An async clipboard read could finish after another operation filled the inbox | Recheck capacity after the read; test fills the quota while the OS adapter is awaited |
| Delayed visibility behind clipboard | Saved phone text was hidden from observers until `pbcopy` returned | Broadcast immediately after persistence; test holds clipboard completion and checks visibility first |
| Lifecycle waits and stale snapshots | A stopped phone request could occupy synchronization for up to its timeout; late state could replace a newer snapshot | Destroy pending HTTP tasks, separate connection epochs, reject older same-epoch revisions; tests exercise cancellation and reordered responses |
| Duplicate receive / false failure after save | Manual and automatic receive could write the same file; a lost receipt made a valid file look failed | Per-item in-flight deduplication and receipt-only retry; tests verify one download, preserved bytes/hash, and eventual completed state |
| Zero-progress write loop | Storage returning zero bytes could spin without progressing | Fail the receive explicitly, with no false receipt; platform-adapter regression reproduces the zero write |
| Nonportable Mac bundle links | Node 24 preserved the npm CLI shim as an absolute link into the source checkout, failing strict codesign | Reproduced on CI and locally with Node 24; omit unused CLI shims and reject remaining runtime symlinks |

Before fixes, the first four targeted tests (filename, missing changes contract, retained SSE, observer cap) failed. The baseline failure output remains in local ignored diagnostics; no personal runtime log was uploaded. Existing TLS/authorization/quota/transfer tests remained enabled.

## New change-feed attack cases

- Missing/expired/revoked credentials never receive a snapshot.
- A credential valid when a long poll starts is checked again when it returns.
- Outdated revisions immediately obtain current state, including changes between successive subscriptions.
- Invalid wait durations are rejected; idle replies omit history and stay under 128 response-body bytes in tests.
- Server restarts use new epochs; clients do not compare sequence numbers across different epochs.
- Automatic file reception runs independently of the notification loop, and old operations are invalidated on background/transport changes.

## Remaining limitations

- No 0.4 phone hardware test was performed while the phone was away. Real BLE throughput, radio contention, long-running stability and the complete interruption matrix remain open.
- A hostile BLE peer may occupy the physical link before TLS authentication. Application authorization prevents data/workflow access, but does not guarantee radio availability.
- A trusted local process can access the loopback admin API and the user's local files. NearBridge is not a security boundary against code already running as that user.
- Text sends have no durable idempotency key. A lost response can leave an ambiguous send; inspect the feed before retrying. Workflow IDs support idempotency on the server, but a new explicit request ID is a new action.
- State change responses still include the latest 200 accessible items. Large text histories can consume significant BLE bandwidth during active updates; per-item delta synchronization is future work.
- File data is fsynced before committing offsets, but all-filesystem sudden-power-loss durability has not been proven. Process restart tests do not establish power-loss safety.
- The tracked-file secret/path scan catches common mistakes; it is not a complete secret scanner. The private repository's visibility was not changed.

See [security policy](../SECURITY.md), [protocol](PROTOCOL.md), [measurements](PERFORMANCE.md), and [test matrix](TESTING.md). Reopen a finding when a counterexample appears; passing tests only support the cases they exercise.
