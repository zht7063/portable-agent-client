# Architecture (state after M1)

```
apps/desktop        Electron main + preload (contextIsolation, sandbox, no node in renderer); renderer = patched new-api web build served on the privileged `<scheme>://app/` protocol (`src/main/app-protocol.ts`, strict CSP, /api stubbed 503 until M3)
  └─ uses @pac/core, @pac/harness, @pac/keychain, @pac/pa-key
packages/core       contract/IPC, http (origin-pinned), session base, keys.secret, fs layer, product config
packages/harness    Pi / Claude Code / Codex adapters (plan → apply → rollback, snapshots, ownership)
packages/keychain   OS keychain (napi on macOS/Windows, secret-tool on Linux)
packages/pa-key     credential helper invoked by harnesses; reads the key from the keychain only
packages/cli        `pac`, a dev/test CLI (not shipped)
```

Product identity (name, app ID, executable, keychain service, protocol scheme, CLI dir) lives **only** in `packages/core/src/product.config.json` (placeholders). Everything else reads it via `@pac/core/product` or, for build scripts, by reading the JSON.

Next milestones (plan v2): M2 vendor and build the new-api web at the `compat.json` pin; M3 main-only proxy session; M4 key flows via the upstream UI; M5 harness UI; M7 CI matrix.
