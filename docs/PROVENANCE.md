# Provenance

This repository was started fresh (no git history carried over). The M1 code was migrated from the earlier client prototype:

- Source: `portable-agent` repository, branch `feat/client`, commit **f2049d8**, directory `client/` (exported with `git archive f2049d8 client`; the source repository was not modified).
- License: the migrated code is relicensed into this AGPL-3.0-only repository by its author.

## What was migrated (adapted)
| Source (`client/`) | Here | Changes |
|---|---|---|
| `packages/core/src/{contract,http,session,state,mask,config,keys}` | `packages/core/src` | `@pa/*` → `@pac/*`. Product strings come from `product.config.json`. No default server. HTTP origin pinning and redirect refusal. IPC trimmed to config + harness. `keys` reduced to `secret`/`forget`. Session refresher moved out of `auth` into `session/refresh.ts`. |
| `packages/core/src/harness/**` | `packages/harness/src` (fs layer → `packages/core/src/fs`) | Split into its own package. `models.ts` keeps only `listWithKey`. |
| `packages/key-helper` | `packages/keychain` + `packages/pa-key` | Split into the keyring backends and the `pa-key` CLI/wrapper. |
| `packages/cli` | `packages/cli` (`pac`) | Commands: `config`, `status`, `models --key`, `keys check`, `harness`. Login, billing and chat were dropped. |
| `apps/desktop/src/{main,preload}` | `apps/desktop/src` | Minimal main: placeholder renderer, config + harness IPC only. Packaging config moved to `electron-builder.config.cjs` (reads the product config). |
| tests | `packages/*/test`, `apps/desktop/test` | Adapted to the above. Every test uses temp HOME/data dirs. |

## What was dropped
- The built-in default server address and any deployment-specific defaults.
- Core modules `auth`, `billing`, `chat` and full key management (`list/create/rename/delete/reveal/copy`), plus their IPC channels. These are replaced by the vendored new-api frontend (M2–M4).
- Renderer panels (login, balance/redeem, keys, chat, settings) and the React renderer. The HarnessPanel UI returns in M5 on top of the upstream component stack.
- `electron-builder.yml` and `electronVersion` pinning (now `electron-builder.config.cjs` using the local Electron dist).

Upstream new-api web (M2) is vendored pristine under `vendor/new-api-web/` (see `UPSTREAM`); our changes to it are the patch queue in `patches/new-api-web/` (README lists each patch and why). See NOTICE.
