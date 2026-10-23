# Contracts (M1)

The source of truth is `packages/core/src/contract/`; this page only explains it. Contract changes need review by everyone working in parallel.

## Packages
- `@pac/core`: plain TS with no Electron or DOM. `fetch`, `clock`, `TokenStore` and `KeyVault` are injected. Subpaths: `./contract` (DTOs, errors, redaction, IPC map), `./fs` (ControlledFs and atomic writes), `./product` (the single product config).
- `@pac/harness`: Pi / Claude Code / Codex adapters, plan/apply/rollback, and the relay model probe (`createModels(http).listWithKey`).
- `@pac/keychain`: OS keychain backends (napi keyring on macOS/Windows, `secret-tool` on Linux, plus memory and none).
- `@pac/pa-key`: the `pa-key` credential helper CLI and its wrapper installer.
- `@pac/cli` (`pac`): dev/test tool only, not shipped. It uses `FileTokenStore`.
- `@pac/desktop`: Electron main and preload, serving the patched new-api web build on the app protocol (M2).

## Result and errors
Every IPC call resolves to `Result<T> = {ok:true,data} | {ok:false,error:{code,message}}`. The codes are `VALIDATION`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `RATE_LIMITED`, `SERVER`, `NETWORK`, `TIMEOUT` and `CANCELLED`. Messages are always redacted (`redact()`): no keys, JWTs, cookies, URLs or hosts. Any response containing a credential-looking field or value is replaced with `SERVER` (`findCredentialLeaks`).

## IPC (renderer ↔ main)
| Channel | Request | Response |
|---|---|---|
| `config:get` | `{}` | `ClientConfig {serverUrl: string \| null, insecureTransport}` |
| `config:set` | `{serverUrl?}` | `ClientConfig` (a URL change clears the session and recreates the core) |
| `harness:detect` / `plan` / `apply`\* / `rollback`\* / `history` / `rollback:preview` | see `contract/harness.ts` | |
| `harness:keyring:status` / `profile:list` / `profile:upsert` / `channel:probe` | see `contract/harness.ts` | |

\* These need `confirm: true` (`CONFIRM_REQUIRED_CHANNELS`). `profile:upsert` with a foreign server origin needs a main-process dialog.
Event: `session:changed` → `SessionView` (credential-free).

The v0 `auth:*`, `billing:*`, `keys:*`, `models:list` and `chat:*` channels were **removed**. In v2, account, billing, keys and chat are served by the vendored new-api frontend through the main-process proxy (M2–M4).

## HTTP (core)
- The origin is pinned. Paths must be absolute (`/…`), with no `//`, backslash or whitespace. Redirects are refused (`redirect: 'manual'`, any 3xx becomes `SERVER`).
- There is no built-in server. A server is configured through `config:set` / `pac config set-url` / `PAC_SERVER_URL`. Non-HTTPS is allowed with a warning only (`insecureTransport: true`).
- Session refresh (`session/refresh.ts`) is single-flight and backs off on transient errors. This is the base that the M3 main-only proxy session replaces.
- `keys.secret(id)` (`POST /api/token/:id/key`) is used only in main, to provision a harness key into the keychain. It is never returned over IPC.
