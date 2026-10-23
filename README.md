# Portable Agent client (placeholder name)

A desktop client for [new-api](https://github.com/QuantumNous/new-api) servers. It configures local coding agents (Pi, Claude Code, Codex) against your relay, and keeps keys in the OS keychain. Status: **M0–M2** of plan v2. The UI is the upstream new-api web frontend (vendored, patched, built with bun + Rsbuild via `scripts/build-new-api-web.sh`); it cannot reach a server yet — the `/api` proxy is M3.

Licensed **AGPL-3.0-only** (see `LICENSE`, `NOTICE`). Based on new-api: *Frontend design and development by New API contributors.* https://github.com/QuantumNous/new-api

## Layout
| Package | What it is |
|---|---|
| `packages/core` (`@pac/core`) | Contract/IPC, origin-pinned HTTP, session base, `keys.secret`, fs layer, **product config** (`src/product.config.json`, the only place for name/app ID). |
| `packages/harness` (`@pac/harness`) | Pi / Claude Code / Codex adapters (plan → apply → rollback). |
| `packages/keychain` (`@pac/keychain`) | OS keychain backends. |
| `packages/pa-key` (`@pac/pa-key`) | Credential helper the harnesses call; reads only the keychain. |
| `packages/cli` (`@pac/cli`, `pac`) | Dev/test CLI. **Not shipped.** |
| `apps/desktop` (`@pac/desktop`) | Electron main + preload; loads the new-api web build on `pac://app/`. |

See `docs/architecture.md`, `docs/contracts.md`, `docs/harness.md`, `docs/compat.md` and `docs/PROVENANCE.md`.

## Develop
Requires Node ≥ 22.18 and bun 1.4 (package manager; this matches upstream new-api web, which uses `bun.lock` and is built with bun in M2).

```bash
bun install
bun run typecheck     # every workspace (tsc --noEmit)
bun run lint          # eslint .
bun run test          # vitest, no network, temp HOME/data dirs only
bun run compat        # validate compat.json
bun run licenses      # third-party license gate (add --write via node to regenerate THIRD-PARTY-LICENSES.md)
bun run check         # all of the above except licenses
```

Desktop: `bun run --filter @pac/desktop smoke` (build + Electron smoke; needs a display or `xvfb-run`; as root it adds `--no-sandbox`). Local package only: `bun run --filter @pac/desktop pack:dir` (`--publish never`, no installers, `@napi-rs/keyring-linux-*` never shipped).

## Server URL
There is **no built-in server**. Set one with:
- Desktop: `config:set`, persisted in `<userData>/config.json` (`{version: 2, serverUrl}`). `PAC_SERVER_URL` only seeds it when no file exists.
- CLI: `pac config set-url https://your-new-api.example`, or the `PAC_SERVER_URL` env var (precedence: env > saved). State lives in `~/.config/portable-agent-cli/` (override with `PA_CLI_DIR`).

URLs must be http/https, with no credentials, query or fragment. Plain `http://` is accepted with a **warning** only.

## Live test
`PAC_LIVE=1 PAC_SERVER_URL=https://… bun run test:live` runs a read-only `/api/status` smoke. It is skipped by default.
