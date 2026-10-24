# src-local — portable-agent-client local pages (AGPL-3.0-only)

Original desktop-only UI that runs inside the vendored new-api web frontend. Not upstream code, so it is not a patch.
`scripts/build-new-api-web.sh` copies this directory to `src/pa-local/` and `routes/` to `src/routes/` before the patch queue runs.

| Path | What |
|---|---|
| `lib/pa.ts`, `lib/pa-types.ts` | Access to the narrow preload bridge (`window.pa`); a hand-written mirror of the renderer contract, kept in sync by `apps/desktop/test/src-local-contract.test.ts`. |
| `harness/` | `/pa/harness`: Pi / Claude Code / Codex cards (status, masked diff preview, apply with confirmation, rollback history) via `pa.harness.*`. |
| `keychain/` | `/pa/keychain`: keychain entries (masked), remove. |
| `server/` | `/pa/server` (and public `/pa-server` before sign-in): server URL change (main asks for native confirmation), version/compat status, HTTP warning, clipboard auto-clear. |
| `tokens/` | API Keys page actions used by patch 0003: Copy key (main writes the clipboard, auto-cleared), Show key (native dialogs in main), Store to keychain. |

Full keys, cookies and access tokens never enter the renderer. Run tests with `scripts/test-local-pages.sh` (upstream vitest, tsgo, oxlint in a prepared `.build/new-api-web`).
