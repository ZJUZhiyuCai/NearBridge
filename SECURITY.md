# Security policy

## Windows 0.7

Windows retains the loopback-only admin and authenticated phone TLS boundaries. WebView2 accepts host messages only from its own loopback root document, blocks external navigation/frames/popups, and accepts drag/drop paths only from browser-provided File objects. Fixed PowerShell operations receive JSON over stdin; phone text cannot become command source. Custom workflows resolve locally selected .lnk files by ID; removing a shortcut prevents later execution.

Data defaults to the current user's LocalAppData. POSIX modes do not set Windows ACLs; retain normal private user-profile ACLs, especially when overriding data paths. Clipboard access is explicit unless incoming-text copying was enabled. Builds are not commercially signed. Bluetooth requires peripheral-role driver support and relays only to the phone TLS port. Folder staging rejects reparse points and bounds content size.

NearBridge is experimental local software. Security fixes target the latest source version; older private builds are not maintained as separate release branches.

In 0.8, the phone stores each computer's credentials, CA, pinned key, Bluetooth settings and pending work in its own profile. Switching cancels old requests and does not replay another profile's operation IDs or uploads. Platform labels and device names never authenticate a computer. The selectable summary excludes sessions and certificates. A corrupt registry fails closed. Removing a computer from the phone list retains downloaded files/journals and does not revoke the desktop-side session; revocation remains an explicit action on that computer.

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

Incremental state baselines are credential-scoped and bounded; stale/unknown baselines fall back to an authorized snapshot. Revocation/rotation aborts active downloads, and expiry is checked once per second. Already transmitted bytes cannot be recalled. Asynchronous upload writes recheck authorization before committing offsets.

The project does not implement Internet relay, unattended background phone operation, remote wake, or multi-user isolation. Do not expose the local admin port through a tunnel or reverse proxy.

## Verification

[Adversarial review](docs/ADVERSARIAL-REVIEW.md) records specific reproductions, fixes and remaining gaps. Tests cover authorization, pairing rotation, stale callbacks, transfer quotas and corrupted/partial data. They are not a formal external audit or a substitute for real-device fault testing.
