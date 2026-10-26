# Performance measurements

## 0.6 · Reconnect and reliable actions

2026-10-26 · Mate 70 Pro+ / HarmonyOS 6, Apple Silicon Mac. One retained device-log sample records:

| Stage | Phone log time |
| --- | --- |
| Start direct connection to remembered Mac | 18:41:19.454 |
| GATT connected | 18:41:19.756 |
| GATT services found | 18:41:20.690 |
| MTU 517 / indications ready | 18:41:21.781 |
| Local TLS forwarding listener ready | 18:41:21.786 |

Elapsed start → listener: **2.332 seconds**, with no discovery phase. The old implementation always scanned for 3.5 seconds before connecting; the new successful remembered-peer path skips that fixed delay. This is one hardware sample, **not** a tap-to-Mac measurement, percentile or general speed guarantee. Subsequent TLS negotiation, request delivery and UI rendering are outside these endpoints. Unreachable/changed BLE addresses still require fallback discovery.

A phone workflow produced a successful server job and a matching durable receipt. The 32,771-byte self-test file on Mac matches its recorded SHA-256; the owner confirmed the phone's round-trip pass. The owner also confirmed automatic mode selected Bluetooth on this network. Automatic LAN selection/recovery, larger files and sustained throughput remain unmeasured.

Reliable text/workflow acceptance now fsyncs the receipt with its result before acknowledging. An isolated loopback benchmark with 50 × 1 KiB synthetic history, six samples per observer, measures that durability cost:

| Mutation request → observed snapshot | Legacy endpoint p50 / p95 | Reliable endpoint p50 / p95 |
| --- | ---: | ---: |
| Mac HTTP observer | 1.49 / 2.03 ms | 6.27 / 12.22 ms |
| Phone-protocol HTTPS observer | 2.04 / 3.71 ms | 6.59 / 7.74 ms |

This adds roughly 5 ms in this fixture; it is a reliability tradeoff, not a latency improvement. Both columns use the same 0.6 service and synthetic fixture, in separate runs. No phone radio or UI is involved; full-ledger performance is not established by twelve new operations. [Legacy samples](performance/legacy-0.6.json), [reliable samples](performance/actions-0.6.json).

```sh
npm run benchmark
npm run benchmark -- --reliable
```


## 0.5 · Active synchronization

2026-10-26 · Node 26.12.1 · Apple Silicon macOS · verified HTTPS on loopback. The fixture contains 200 synthetic text items of 8 KiB each; both response modes observe the same mutation. Six samples per scenario, alternating which mode requests first to distribute snapshot-cache cost.

| Change | Full response body, p50 | Delta response body, p50 | Reduction |
| --- | ---: | ---: | ---: |
| Workflow result | 1,674,522 bytes | 1,802 bytes | 99.89% |
| Receipt on one 8 KiB text | 1,675,583 bytes | 11,147 bytes | 99.33% |
| Small new text / rolling window | 1,642,999 bytes | 10,779 bytes | 99.34% |

The incremental response still includes current workflow/job metadata. Changed items include the whole item; an order change carries the window's ID list. Bootstrap, unknown/evicted baselines and small histories may use full snapshots. The client does not opt into deltas until it has a baseline. Old clients retain the full-response contract.

Observed request/response p50 was 3.27 → 0.68 ms for workflow updates, 3.12 → 0.34 ms for receipts, and 4.02 → 0.30 ms for new text. These small local timings are descriptive. They include server work and JSON parsing, but exclude the preceding mutation, UI rendering, radio contention and connection establishment. **No actual phone/BLE latency or throughput improvement is claimed from this benchmark.** Response-byte savings are the primary result.

```sh
npm run benchmark:active
```

The script creates temporary certificates, a temporary service and synthetic history, with inert OS adapters. It never touches the installed app, personal files or real clipboard/workflows. [Raw samples](performance/active-0.5.json) include request timings and payload counts. Initial sync is bounded to 200 items / 8 MiB encoded history; the phone still serializes the merged history into UI storage. Upload writes/fsync are asynchronous while preserving offset durability; index metadata remains synchronous.

## 0.4 · Notification latency

2026-10-26 · Node 26.12.1 · Apple Silicon macOS · synthetic history · isolated HTTP/verified HTTPS on loopback.

### Result

| Mutation request → visible snapshot | Previous 2/3-second polling, p50 / p95 | Change wait, p50 / p95 |
| --- | --- | --- |
| Mac observer | 1001.16 / 1803.22 ms | 0.98 / 1.26 ms |
| Phone-protocol observer over HTTPS | 1502.81 / 2702.99 ms | 1.44 / 1.83 ms |

Six samples per role. The baseline dispatched changes at 10%, 50%, and 90% of each poll period, repeated twice. The change-wait run subscribed before dispatch and measured when the returned snapshot contained the new item. Timing begins immediately before the mutation request, so request/storage/serialization time is included.

This establishes that the fixed polling delay is removed. It **does not** measure screen rendering, actual phone latency, Wi-Fi interference, BLE airtime, or file throughput. Small sample counts are descriptive, not a universal latency guarantee.

With 50 synthetic 1 KiB history entries plus probes, the old phone polling strategy would transfer about **1,267,740 response-body bytes/minute while idle**. A revision-only heartbeat every 25 seconds projects to **129.6 bytes/minute**. This comparison excludes HTTP/TLS/BLE framing, discovery and retries. Non-idle notifications still carry a complete bounded state snapshot; this version does not implement per-item deltas.

### Reproduce

```sh
npm ci --ignore-scripts
npm run benchmark -- --poll
npm run benchmark
```

The probe starts temporary servers, creates test certificates and synthetic data, and removes them afterwards. It does not access the running personal service, phone, clipboard, shortcuts or inbox. Raw JSON samples used above are in [performance fixtures](performance/).

The `--poll` option retains the previous strategy as a reproducible control. Baseline data was recorded before changing the service; the current implementation can also run that control. Avoid running heavy builds during measurements. Treat differences below a few milliseconds as noise until measured repeatedly on the relevant hardware.

### Implementation and limits at 0.4

- `/api/changes` waits for a revision change; a 25-second timeout sends only a small heartbeat. History is not rendered again on idle heartbeats.
- Phone HTTP tasks are cancelled on transport/lifecycle changes. File receive work and state updates do not share one blocking loop.
- Successful foreground sends/workflows rely on the notification response instead of awaiting an extra full-state GET.
- File sizes, chunk fsync, TLS validation and hash receipts are unchanged. No integrity checks were removed to improve timing.
- Node HTTP keep-alive is 30 seconds, with connection/observer bounds. [Node HTTP reference](https://nodejs.org/api/http.html).
- HarmonyOS still creates one `HttpRequest` per task and destroys it after use, as required by the official SDK type contract. Existing platform connection pooling is retained; this change does not claim a TLS handshake was removed from every request. [Official HTTP interface](https://github.com/openharmony/interface_sdk-js/blob/master/api/@ohos.net.http.d.ts).

Next hardware measurement: tap-to-Mac execution, Mac-send-to-phone-display, and verified file round-trip, each recorded separately for LAN and BLE. See [test matrix](TESTING.md).
