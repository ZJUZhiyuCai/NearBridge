# Changelog

## 0.7.0 — 2026-10-27

- Make Windows the primary desktop; retain HarmonyOS layouts, pairing/CA/pin verification, receipts, transfer limits, reliable operations and automatic LAN/BLE routing.
- Add a .NET 10 WinForms/WebView2 tray host, Ctrl+Alt+Space, Explorer Send To, drag/drop, bounded ZIP packaging, durable upload queues and action journals. Lost responses reuse their ID after restart.
- Implement the existing BLE UUIDs/TLS framing with Windows GATT, MTU limits, serialized indications and four bounded streams. Detect peripheral-role support and tolerate the driver's transient Aborted/Success event before Started.
- Adapt clipboard/Explorer/allowlisted .lnk workflows, OpenSSL discovery, LocalAppData, Windows filenames and cross-volume inbox copies. Publish Windows mDNS.
- Support Windows DevEco paths, including JBR on the child-process PATH for HAP packaging; add Windows CI and compiled-client tests, and keep existing macOS sources and historical evidence.
- Official Windows DevEco signing/build and Mate 70 Pro+ cover-install passed. Native pairing, LAN file receipt and the BLE 32 KB round-trip have hardware evidence; Bluetooth speed and long-running stability remain limited/unmeasured. See [Windows verification](docs/WINDOWS-VERIFICATION.md).

## 0.6.0 — 2026-10-26

- Reconnect directly to the remembered BLE device; scan only on failure and stop early when the selected device is found. Cancel pending GATT work immediately, isolate late callbacks and apply bounded retry/backoff.
- Add automatic, Bluetooth-only and LAN-only connection modes. Automatic mode probes the pinned LAN endpoint before falling back to the selected BLE peer; transfers and actions keep their route until completion. Existing explicit choices survive upgrades.
- Persist text/workflow operation IDs on both native clients before submission. A separate bounded server receipt ledger survives history deletion/trimming and restart; seven-day expiry rejects stale retries instead of executing them again. Failed commits roll back before side effects.
- Add explicit “retry confirmation” and “end retry” controls. Bind pending actions to their original pairing; never replay workflows on app startup. Dedicated reliable endpoints prevent older servers from silently ignoring IDs.
- Preserve the installed Mac app directory when updating; copy a recoverable backup instead of renaming the app and moving its OS permission entry to the backup. Verify staged/final bundles and restore old contents on replacement failure.
- Add radio-adapter, journal-recovery, transport-selection and real HTTP/TLS regressions. Native builds and 83 local tests pass; device evidence and remaining limits are recorded in [verification](docs/VERIFICATION.md).

Upgrade Mac first, then the phone. Basic BLE reconnect, workflow and 32 KB self-test passed on Mate 70 Pro+; automatic BLE fallback is user-confirmed. Automatic LAN selection, large-file throughput and the full fault matrix remain to be tested on hardware.

## 0.5.0 — 2026-10-26

- Optional item deltas for both native clients: changed items, removals and ordering, with exact-baseline validation and full-snapshot fallback. Older clients keep their existing protocol.
- Credential-scoped baseline caches retain only bounded ID/hash manifests. Encoded history is capped at 8 MiB to prevent escaped text from exceeding the phone HTTP limit; individual text remains intact.
- Asynchronous upload writes and fsync keep the event loop available. Recheck authorization after disk I/O; zero writes and failed metadata commits do not advance resumable offsets.
- Abort already streaming downloads on revocation/credential rotation; check expiry each second. Duplicate valid receipts no longer write the index or wake observers again.
- Roll back a receipt marker on persistence failure, and invalidate cached state when an offline pairing expires.
- Add actual Swift and ArkTS delta regressions, streaming-revocation and controlled slow-disk cases, plus an isolated active-sync benchmark. See [review](docs/ADVERSARIAL-REVIEW.md) and [measurements](docs/PERFORMANCE.md).

Later the same day, 0.5 cover-install, retained pairing, 32 KB BLE self-test and a phone-triggered workflow were verified. BLE throughput and the full fault matrix remain pending.

## 0.4.0 — 2026-10-26

### Responsiveness

- Native clients wait for changes instead of polling full history every 2/3 seconds. Idle responses contain only a revision; state changes wake pending requests immediately.
- Phone transfers run independently of state notifications. A committed action no longer waits for a redundant state snapshot.
- Backgrounding or changing transports cancels active phone HTTP tasks. Reconnects use bounded backoff; old snapshots cannot roll state back.

### Reliability and security

- Close event subscriptions when credentials rotate, including migrations that retain the device ID. Reauthorize delayed snapshots before delivery.
- Bound notification clients and HTTP connections; drop slow SSE readers. Recheck QR expiry after reading the request body.
- Limit filenames by UTF-8 bytes while preserving extensions and collision suffixes.
- Deduplicate simultaneous receives, preserve files when only acknowledgement fails, and fail zero-progress disk writes.
- Publish saved text before waiting for clipboard completion; recheck clipboard-send capacity after the asynchronous OS read.

### Repository

- MIT license, contributor/security policies, issue and PR templates, code ownership, architecture/protocol/testing documents, and reproducible latency benchmark.
- CI for Node 22/24/26 on Linux plus Swift compilation and signature validation on macOS. Actions are pinned to verified commit SHAs and receive read-only repository permissions.
- Centralized server/Mac version metadata, full JavaScript syntax checks, version checks, tracked-secret/path checks, and local documentation-link validation.
- Exclude npm CLI shims from the Mac runtime and reject leftover symlinks; Node 24 builds now retain strict bundle-signature validation.

Phone hardware latency, BLE throughput, and 0.4 device fault recovery remain pending. See the [test matrix](docs/TESTING.md).

## 0.3.0 — 2026-10-26

- Claude-designed blue/white/gray native interfaces, Mac sidebar and conversation feed, phone single-home layout and connection sheet.
- Structured connection/transfer states, pairing rollback, and successful-action refresh handling.
- Local builds completed; see [0.3 delivery record](docs/REDESIGN-0.3.md) for its hardware validation boundary.

## 0.2.0 — 2026-10-25–26

- Native macOS/HarmonyOS clients, system sharing, private-CA pairing, resumable files, SHA-256 receipts, and approved Mac workflows.
- Experimental BLE TLS tunnel; small file round trips and a phone-triggered Mac workflow verified on real hardware.
- [Historical verification](docs/VERIFICATION.md) and [BLE evidence](docs/BLUETOOTH.md).
