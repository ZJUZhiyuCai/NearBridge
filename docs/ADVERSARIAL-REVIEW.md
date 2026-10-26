# Adversarial review · 0.6

## Third pass · 2026-10-26

This is an internal review of reconnection, ambiguous side effects and automatic transport selection. The added tests use actual source with deterministic adapters plus real HTTP/TLS. They establish the listed cases; they are not independent certification or full radio fault coverage.

| Finding / counterexample | Change and evidence |
| --- | --- |
| Every reconnect paid a fixed 3.5-second scan | Try the remembered peer directly, scan on failure, stop early on a matching report; controlled-radio tests and one hardware log with no scan (2.332 s to local listener) |
| Cancelled connect/write callbacks could clear or break the next connection | Generation and GATT-instance guards, cancellable stage waits, ownership checks for shared promises and writer cleanup; tests stop hanging connect/services/listener and deliver late write failures |
| Link errors blocked forever or could provoke repeated radio work | 2/4-second cooldowns, pause after three failed rounds, explicit reset; deterministic radio-call counts verify the circuit stops touching the radio |
| Lost text/workflow replies invited duplicate operations | Native durable journals and a separate server receipt ledger; restart, deleted text, pruned jobs, full ledger, expiry, timestamp/content mismatch and legacy-job receipt upgrade are exercised |
| Disk failure could acknowledge an operation only in memory | Commit result and receipt together, fsync before replacement, roll back memory on failure; injected write errors prove no workflow starts and retries remain possible |
| An older server could ignore new idempotency fields | New reliable endpoints plus advertised capability; old servers cannot silently accept the new request shape |
| A retry after re-pairing could target another device | Phone pairing-scope binding, Mac target binding, no startup replay; mismatched scopes/content reject before submission |
| Automatic fallback could replay a mutation or change file routes between chunks | Anonymous pinned LAN probes, one shared route decision, no route change while requests/actions/transfers are active; pure BLE never probes LAN; late probes cannot override a manual choice |
| Moving the old Mac app made its Bluetooth permission entry follow the backup | Reproduced in System Settings after the final install. Copy the backup, retain the installed app directory, verify signatures and roll back failed replacements; filesystem-identity/failure tests and a real signed-bundle replacement smoke test pass. Ad-hoc updates can still require OS reauthorization |
| A corrupt/partially written local journal could mint a new ID | Atomic journal replacement, full UTF-8 writes with zero-write detection, fail-closed load and explicit inspect/end-retry controls |

Local suite: 83 passing tests. Mac and HarmonyOS builds/signatures pass. Real-device scope: updated pairing/history retained, direct BLE reconnect, one independently verified phone workflow with receipt, Mac self-test file hash, and user confirmation of round-trip pass and automatic BLE fallback. Automatic LAN and full fault injection remain unverified on hardware. [Measurements](PERFORMANCE.md) explicitly record the small fsync cost instead of claiming every operation became faster.


## Second pass · 2026-10-26

This pass targets active synchronization cost, disk stalls and authorization during in-flight operations. Three new HTTP reproductions failed on 0.4 before implementation: incremental history delivery, duplicate-receipt revision stability, and revoking an already streaming download. Baseline failure output stays in ignored local diagnostics.

| Finding | Impact / trigger | Fix and evidence |
| --- | --- | --- |
| Every change retransmitted history | Workflow/receipt updates included up to 200 unchanged text bodies, competing with actual BLE traffic | Opt-in item deltas, bounded credential-scoped manifests, optional ordering and smaller-response fallback; real HTTP tests reconstruct exact snapshots after missed changes, deletion and window eviction |
| Escaped text exceeded native response limits | Valid 64 KiB text can expand sixfold in JSON; 200 such records exceed the phone's 20 MiB HTTP limit | Limit encoded history to 8 MiB while preserving whole individual texts; regression uses control-character-heavy history |
| Revoked download continued streaming | Authentication was checked at download start only; a slow peer could consume the rest after revocation | Abort registered downloads on revocation/rotation, check expiry each second; real TLS slow-reader regression confirms an incomplete aborted stream |
| Duplicate receipts amplified writes/notifications | Repeating a valid acknowledgement persisted the index and increased revisions each time | Keep hash validation, return success without a second write/broadcast; regression confirms stable receipt and revision |
| Failed receipt commit left a false marker | A disk error after setting `receivedAt` could make the retry look already committed | Roll back the in-memory marker if persistence fails; inject a save failure, then retry and verify the on-disk receipt |
| Offline pairing expiry left cached state stale | An offline device expiring did not change presence, so a cached `paired: true` snapshot could remain indefinitely | Track pairing validity in the expiry sweep; regression expires an offline pair and verifies Mac observers/cache update |
| Synchronous chunk fsync blocked other work | A slow disk held the Node event loop during uploads; zero writes could loop forever, and metadata failure advanced the in-memory offset | Async writes/fsync, progress checks, reauthorization after I/O and publish-after-persist offsets; controlled adapters exercise slow sync, zero/partial writes, revocation and metadata failure with retry |

Additional regressions cover credential/role isolation, manifest eviction, immutable receipt baselines, malformed/incomplete deltas, duplicate ordering and stale responses. Both native merge implementations are executed: compiled Swift plus actual ArkTS business source with platform adapters. Clients bootstrap on invalid baselines instead of applying partial updates. TLS, size limits, fsync and SHA-256 checks remain enabled.

Final review reproduced two additional failures in the candidate implementation before fixing them: receipt-save rollback and offline pairing expiry. These are part of the regression suite, not untested review suggestions.

The synthetic 200 × 8 KiB history benchmark reduces median workflow response body from 1,674,522 to 1,802 bytes (99.89%). Receipts and new text reduce by about 99.3%. These are response-body comparisons over loopback HTTPS, not phone/BLE measurements. See [method and raw samples](PERFORMANCE.md).

## First pass · 0.4

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

## Remaining limitations (current 0.6)

- Basic 0.5/0.6 phone tests were completed after the phone returned. Real BLE throughput, radio contention, long-running stability, automatic LAN behavior and the complete interruption matrix remain open.
- A hostile BLE peer may occupy the physical link before TLS authentication. Application authorization prevents data/workflow access, but does not guarantee radio availability.
- A trusted local process can access the loopback admin API and the user's local files. NearBridge is not a security boundary against code already running as that user.
- Reliable native operations require the 0.6 server and preserved original ID/timestamp. Receipts last seven days, with at most 4096 live entries; expiry rejects the old operation. Deleting the local pending journal or explicitly ending retries allows a new operation. Legacy web text and old clients retain their older semantics.
- Initial/unknown/evicted baselines still require a full bounded snapshot. Changed items carry the full item, including its text, and the phone still serializes the reconstructed state for UI storage. Further CPU/rendering and real BLE optimization need device measurements.
- Upload data I/O is asynchronous, but index/transfer-metadata writes and some other local operations remain synchronous. Controlled slow-disk tests establish scheduling/commit behavior, not performance on every physical disk.
- Download cancellation cannot recall bytes already sent or queued in the network. Expiry detection has up to a one-second interval.
- File data is fsynced before committing offsets, but all-filesystem sudden-power-loss durability has not been proven. Process restart tests do not establish power-loss safety.
- The tracked-file secret/path scan catches common mistakes; it is not a complete secret scanner. The private repository's visibility was not changed.

See [security policy](../SECURITY.md), [protocol](PROTOCOL.md), [measurements](PERFORMANCE.md), and [test matrix](TESTING.md). Reopen a finding when a counterexample appears; passing tests only support the cases they exercise.
