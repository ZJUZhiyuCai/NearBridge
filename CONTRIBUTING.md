# Contributing

Windows and Mac are supported desktops in 0.8. Windows uses .NET 10 SDK, Git for Windows/OpenSSL and WebView2. Run npm run build:windows before npm test to include compiled-client tests. npm run install:windows installs for the current user and adds Explorer Send To; Mac retains build:mac and install:mac. Shared phone build scripts support both DevEco layouts. See [Windows setup](windows/README.md).

NearBridge connects a Mac and a HarmonyOS phone using native interfaces and local transports. Small, reproducible changes are easier to review than broad rewrites.

## Development

Use Node.js 22.13 or later. macOS builds also require Apple Command Line Tools. HarmonyOS builds require the official DevEco Studio toolchain and your own device signing configuration.

```sh
npm ci --ignore-scripts
npm run check
npm test
```

The tests create temporary directories, local test certificates, and fake OS adapters. They never read your clipboard, run your existing shortcuts, or use your paired phone. Linux runs the server and phone-client tests; the actual Swift BLE codec test runs on macOS.

```sh
npm run build:mac
codesign --verify --deep --strict dist/NearBridge.app
npm run build:phone
npm run benchmark
```

Only `npm run install:mac` installs a Mac build. Phone installation is a separate, device-specific step. See [HarmonyOS setup](harmony/README.md), [architecture](docs/ARCHITECTURE.md), and [protocol](docs/PROTOCOL.md).

## Changes and review

1. Create a focused branch from `main` and describe a reproducible problem.
2. Add a failing regression test for behavioral fixes, then implement the change. Do not add snapshot tests that merely repeat the code.
3. Run the relevant checks. For cross-platform changes, build both clients when the SDK is available; record unavailable checks honestly.
4. Update the changelog and the affected contract or setup documentation. Increment `package.json`, its lockfile, and `harmony/AppScope/app.json5` together; `npm run check` validates consistency. Mac and server versions derive from `package.json`.
5. Explain the final behavior, validation, compatibility, and remaining device tests in the PR.

Never commit local signing profiles, certificates, private keys, pairing credentials, received files, device identifiers, or personal screenshots. `npm run check` scans tracked files for common mistakes; it is a guardrail, not a full secret scanner.

## Non-negotiable contracts

- Keep CA validation, public-key pinning, explicit pairing approval, and server-side authorization.
- BLE must not silently fall back to LAN while claiming Bluetooth delivery.
- A file is received only after storage and SHA-256 verification; queue acceptance is a different state.
- Old asynchronous operations must not overwrite a new connection's state.
- Phone commands select Mac-approved workflow IDs; they cannot supply shell commands or arbitrary shortcut parameters.
- Benchmarks on loopback or fake platform adapters are not hardware performance results.

## License

Contributions are provided under the repository's [MIT license](LICENSE). Keep attribution and third-party license notices. Report security issues through the [security policy](SECURITY.md).
