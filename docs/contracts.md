# Contracts (M1)

The source of truth is `packages/core/src/contract/`; this page only explains it. Contract changes need review by everyone working in parallel.

## Packages
- `@pac/core`: plain TS with no Electron or DOM. `fetch`, `clock`, `TokenStore` and `KeyVault` are injected. Subpaths: `./contract` (DTOs, errors, redaction, IPC map), `./fs` (ControlledFs and atomic writes), `./product` (the single product config).
- `@pac/harness`: Pi / Claude Code / Codex adapters, plan/apply/rollback, and the relay model probe (`createModels(http).listWithKey`).
- `@pac/keychain`: OS keychain backends (napi keyring on macOS/Windows, `secret-tool` on Linux, plus memory and none).
- `@pac/cli` (`pac`): dev/test tool only, not shipped. It uses `FileTokenStore`.
- `@pac/desktop`: Electron main and preload, serving the patched new-api web build on the app protocol (M2).

## Result and errors
Every IPC call resolves to `Result<T> = {ok:true,data} | {ok:false,error:{code,message}}`. The codes are `VALIDATION`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `RATE_LIMITED`, `SERVER`, `NETWORK`, `TIMEOUT` and `CANCELLED`. Messages are always redacted (`redact()`): no keys, JWTs, cookies, URLs or hosts. Any response containing a credential-looking field or value is replaced with `SERVER` (`findCredentialLeaks`).

## IPC (renderer ↔ main)
| Channel | Request | Response |
|---|---|---|
| `config:get` | `{}` | `ClientConfig {serverUrl: string \| null, insecureTransport}` |
| `config:set` | `{clipboardClearSeconds?}` | `ClientConfig` (strict schema; origin is fixed at build time) |
| `harness:detect` / `plan` / `apply`\* / `rollback`\* / `history` / `rollback:preview` | see `contract/harness.ts` | |
| `harness:keyring:status` / `profile:list` / `profile:upsert` / `channel:probe` | see `contract/harness.ts` | |

\* These need `confirm: true` (`CONFIRM_REQUIRED_CHANNELS`). Provider inputs contain no address fields; extra fields are rejected.
Event: `session:changed` → `SessionView` (credential-free).

The v0 `auth:*`, `billing:*`, `keys:*`, `models:list` and `chat:*` channels were **removed**. In v2, account, billing, keys and chat are served by the vendored new-api frontend through the main-process proxy (M2–M4).

## HTTP (core)
- The origin is pinned. Paths must be absolute (`/…`), with no `//`, backslash or whitespace. Redirects are refused (`redirect: 'manual'`, any 3xx becomes `SERVER`).
- Desktop uses a build-time fixed HTTPS origin from apps/desktop/build/server-origin.json; dev-only CLI URL configuration is independent. There is no renderer-controlled server. Only the dev CLI configures its address through `pac config set-url` / `PAC_SERVER_URL`; the desktop uses the committed build constant.
- Session refresh (`session/refresh.ts`) is single-flight and backs off on transient errors. The desktop renderer's login session is the M3 main-only proxy session (docs/proxy.md); `@pac/core`'s session remains for the CLI.
- `keys.secret(id)` (`POST /api/token/:id/key`) is used only in main, to provision a harness key into a private plaintext key file. It is never returned over IPC.
