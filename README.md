# swift-client

A desktop client for [new-api](https://github.com/QuantumNous/new-api) servers. It configures Claude Code and Codex against your relay, storing harness keys in private plaintext files (0600/0700 on POSIX, protected ACLs on Windows). The UI is the upstream new-api web frontend (vendored, patched, built with bun + Rsbuild via `scripts/build-new-api-web.sh`); renderer `/api/*` requests are forwarded by the main process to the configured server with a main-only session (M3, see `docs/proxy.md`).

Licensed **AGPL-3.0-only** (see `LICENSE`, `NOTICE`). Based on new-api: *Frontend design and development by New API contributors.* https://github.com/QuantumNous/new-api

## Layout
| Package | What it is |
|---|---|
| `packages/core` (`@pac/core`) | Contract/IPC, origin-pinned HTTP, session base, `keys.secret`, fs layer, **product config** (`src/product.config.json`, the only place for name/app ID). |
| `packages/harness` (`@pac/harness`) | Claude Code / Codex adapters; Pi env mode for the dev CLI (plan → apply → rollback). |
| `packages/keychain` (`@pac/keychain`) | OS keychain backends. |
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

## Server and harness keys

Desktop `SERVER_ORIGIN` is fixed at build time from `apps/desktop/build/server-origin.json`; settings show it read-only and `config:set` rejects address fields. The committed origin is `http://185.115.207.247:3000` — **plain HTTP**, a time-limited D-17 exception for the v0.1.0-beta.3 pre-release only (see [harness configuration](docs/harness.md#d-17-exception-time-limited-v010-beta3)). Keys and code context travel in cleartext until HTTPS is live. Only unpackaged smoke builds with `PA_SMOKE=1` allow an address override.

The private **dev/test-only** CLI retains `pac config set-url` / `PAC_SERVER_URL` and its own `FileKeyVault` under `~/.config/portable-agent-cli/`; it is not packaged or published.

Harness keys are **plaintext**, protected by private file permissions/ACLs. They are written into Codex and Claude config files; Claude commands, hooks and MCP children inherit the token. Exclude those directories from cloud sync/dotfiles, set server quota limits, and detach before uninstalling. See [harness configuration](docs/harness.md) for cleanup, migration, paid-test safeguards and the current L3 limitation.

## Live test
`PAC_LIVE=1 PAC_SERVER_URL=https://… bun run test:live` runs a read-only `/api/status` smoke. It is skipped by default.

M3 local integration (official new-api release binary, throwaway DB and fake account, loopback-only network namespace;
runs the live proxy test and an xvfb Electron login smoke, then deletes everything):
`NEWAPI_BIN=/path/new-api-v1.0.0-rc.46 unshare -rn scripts/integration-local-newapi.sh`. Never point it at a real server.
