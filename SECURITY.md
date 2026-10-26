# Security policy

NearBridge is experimental local software. Security fixes target the latest source version; older private builds are not maintained as separate release branches.

## Reporting

Use **Security → Report a vulnerability** if the repository offers that private reporting entry. Otherwise, contact [@ZJUZhiyuCai](https://github.com/ZJUZhiyuCai) through an existing private collaboration channel. Do not put exploitable details, pairing QR codes, tokens, private certificates, device IDs, or personal files in a public issue.

Include the affected commit, environment, smallest reproduction, expected authorization boundary, and observed impact. Synthetic data and redacted logs are sufficient. Ordinary defects belong in the bug-report form.

## Trust boundaries

| Surface | Boundary |
| --- | --- |
| Mac admin API, `127.0.0.1:53318` | Trusted local user/processes. Host, Origin and Fetch Metadata reject browser cross-site access; the service is not a sandbox against hostile local processes. |
| Phone HTTPS, ports 53319 / 53320 | Pairing token, explicit Mac approval, expiring session; native client also validates its private CA and pinned SPKI. |
| mDNS and BLE discovery | Untrusted addresses/names. Discovery is not authentication. BLE forwards TLS only to the phone endpoint. |
| Workflow execution | Only enabled IDs selected on the Mac. No remote shell strings. An interrupted shortcut may already have produced external effects. |
| Files | Bounded sizes, collision-safe names, resumable offsets, SHA-256 and receiver acknowledgement. Local storage is protected by OS account/file permissions, not application-level disk encryption. |

Each HTTP listener limits connections; notifications have per-role limits and close slow readers. Long-poll responses reauthorize at delivery. These bounds reduce resource exhaustion, but do not promise availability against a hostile network or radio peer. A BLE peer can still occupy the physical connection before application authentication.

The project does not implement Internet relay, unattended background phone operation, remote wake, or multi-user isolation. Do not expose the local admin port through a tunnel or reverse proxy.

## Verification

[Adversarial review](docs/ADVERSARIAL-REVIEW.md) records specific reproductions, fixes and remaining gaps. Tests cover authorization, pairing rotation, stale callbacks, transfer quotas and corrupted/partial data. They are not a formal external audit or a substitute for real-device fault testing.
