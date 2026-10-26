# Performance measurements

2026-10-26 · Node 26.12.1 · Apple Silicon macOS · synthetic history · isolated HTTP/verified HTTPS on loopback.

## Result

| Mutation request → visible snapshot | Previous 2/3-second polling, p50 / p95 | Change wait, p50 / p95 |
| --- | --- | --- |
| Mac observer | 1001.16 / 1803.22 ms | 0.98 / 1.26 ms |
| Phone-protocol observer over HTTPS | 1502.81 / 2702.99 ms | 1.44 / 1.83 ms |

Six samples per role. The baseline dispatched changes at 10%, 50%, and 90% of each poll period, repeated twice. The change-wait run subscribed before dispatch and measured when the returned snapshot contained the new item. Timing begins immediately before the mutation request, so request/storage/serialization time is included.

This establishes that the fixed polling delay is removed. It **does not** measure screen rendering, actual phone latency, Wi-Fi interference, BLE airtime, or file throughput. Small sample counts are descriptive, not a universal latency guarantee.

With 50 synthetic 1 KiB history entries plus probes, the old phone polling strategy would transfer about **1,267,740 response-body bytes/minute while idle**. A revision-only heartbeat every 25 seconds projects to **129.6 bytes/minute**. This comparison excludes HTTP/TLS/BLE framing, discovery and retries. Non-idle notifications still carry a complete bounded state snapshot; this version does not implement per-item deltas.

## Reproduce

```sh
npm ci --ignore-scripts
npm run benchmark -- --poll
npm run benchmark
```

The probe starts temporary servers, creates test certificates and synthetic data, and removes them afterwards. It does not access the running personal service, phone, clipboard, shortcuts or inbox. Raw JSON samples used above are in [performance fixtures](performance/).

The `--poll` option retains the previous strategy as a reproducible control. Baseline data was recorded before changing the service; the current implementation can also run that control. Avoid running heavy builds during measurements. Treat differences below a few milliseconds as noise until measured repeatedly on the relevant hardware.

## Implementation and limits

- `/api/changes` waits for a revision change; a 25-second timeout sends only a small heartbeat. History is not rendered again on idle heartbeats.
- Phone HTTP tasks are cancelled on transport/lifecycle changes. File receive work and state updates do not share one blocking loop.
- Successful foreground sends/workflows rely on the notification response instead of awaiting an extra full-state GET.
- File sizes, chunk fsync, TLS validation and hash receipts are unchanged. No integrity checks were removed to improve timing.
- Node HTTP keep-alive is 30 seconds, with connection/observer bounds. [Node HTTP reference](https://nodejs.org/api/http.html).
- HarmonyOS still creates one `HttpRequest` per task and destroys it after use, as required by the official SDK type contract. Existing platform connection pooling is retained; this change does not claim a TLS handshake was removed from every request. [Official HTTP interface](https://github.com/openharmony/interface_sdk-js/blob/master/api/@ohos.net.http.d.ts).

Next hardware measurement: tap-to-Mac execution, Mac-send-to-phone-display, and verified file round-trip, each recorded separately for LAN and BLE. See [test matrix](TESTING.md).
