# Test matrix

Automated checks run against synthetic data in temporary directories. Hardware evidence is tracked separately so a passing CI run cannot be mistaken for phone validation.

| Check | Command / environment | What it establishes |
| --- | --- | --- |
| Syntax, versions, repository hygiene | `npm run check` | All JS/MJS parses, metadata matches, common secret/private paths excluded, local Markdown links resolve |
| Server and client regressions | `npm test`, Node 22.13+ | Real HTTP/TLS, pairing and authorization, quotas, resumable files, receipts, jobs, actual ArkTS business source with in-memory platform adapters |
| Swift protocol/state models | Included in `npm test` on macOS | Actual Swift framing and MTU reassembly; delta merge, missing/duplicate IDs, receipts, stale revision rejection |
| Mac application | `npm run build:mac` then `codesign --verify --deep --strict dist/NearBridge.app` | Native source compiles for declared macOS 13 minimum; ad-hoc bundle signature validates |
| HarmonyOS application | `npm run build:phone` | Strict ArkTS compilation with official SDK and local signing when configured |
| Latency | `npm run benchmark` | Server mutation-to-observation over loopback HTTP/HTTPS; no real BLE latency claim |
| Active synchronization | `npm run benchmark:active` | Full versus incremental HTTPS response bytes for workflows, receipts and new text with a synthetic 200-item history |

CI runs Node 22/24/26 on Linux and Node 24 plus Swift compilation on macOS 15. Linux intentionally skips the two Swift-only tests. Phone-client tests require Node's built-in TypeScript stripping. HarmonyOS SDK/signing material is not uploaded to CI; record the local build result separately.

## Real-device checklist for 0.5

Use the same paired phone and cover-install the new HAP; do not uninstall or clear data.

1. Confirm Mac Bluetooth system authorization and phone pairing/history survive the update.
2. Send text in both directions; record tap-to-visible latency and state the transport.
3. Trigger **打开收件目录** and confirm the Mac job result, not just button feedback.
4. Send a synthetic file both ways and compare source, stored-file and receipt SHA-256.
5. Run the BLE 32 KiB round-trip check. Distinguish the Wi-Fi debug link from the business transport.
6. Start a transfer, background the phone, return, and verify no duplicate/lost file or stale UI state. Repeat with explicit transport switching.
7. Interrupt only the acknowledgement after saving a file; reconnect and verify no second download.
8. Check simultaneous incoming/outgoing transfers, screen lock, low storage, system sharing, and a larger multi-chunk file.
9. Keep a large synthetic text history, trigger workflows and confirm incremental updates preserve unchanged text and ordering. Restart the Mac service to exercise full-snapshot fallback.
10. Revoke/rotate pairing while downloading a synthetic file; no new bytes should be produced after cancellation, allowing for network bytes already in flight.

The existing 0.2 device evidence is a baseline. It does not validate the redesigned 0.3–0.5 phone UI or the new notification/delta lifecycle. Large-file throughput, long-running BLE stability and the complete fault matrix remain unverified. Slow-disk tests use a controlled file adapter to verify scheduling and commit behavior, not a physical failing disk.

## Evidence standards

Record version/commit, OS/API versions, transport, sizes, hash results, elapsed-time endpoints, and failed cases. Keep personal photos, live QR codes, signing data and raw private runtime logs outside Git. Include only synthetic fixtures or redacted summaries in issues and PRs.

See [latency measurements](PERFORMANCE.md), [adversarial review](ADVERSARIAL-REVIEW.md), and [historical verification](VERIFICATION.md).
