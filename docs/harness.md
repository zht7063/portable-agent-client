# Harness configuration

swift-client configures Codex CLI and Claude Code directly. Gemini is not implemented or detected. Protocol conversion remains on the server. The `pac` CLI is a private development/test tool, with its own `FileKeyVault`; it never uses desktop credentials.

## Server and migration

The desktop origin is fixed at build time from `apps/desktop/build/server-origin.json`, injected by `build-main.mjs`. The committed `https://api.swift-client.invalid` is a **TODO placeholder pending D-17 HTTPS readiness**. Official releases must wait for the reviewed production origin. Settings display the origin read-only. Old `config.json.serverUrl` is ignored and removed; old-origin sessions are cleared. Select a token again after server migration; legacy keychain entries are not read or migrated.

Only an unpackaged smoke build with `PA_SMOKE=1` can use `PAC_SERVER_URL`. Production dead-code elimination removes that path. The dev-only CLI retains independent URL configuration.

## Credentials and risks

Harness keys are **plaintext** in `<userData>/harness/keys.json` and in agent configuration files. POSIX files use 0600 and directories 0700, verified after writing. Windows uses protected ACLs granting only the current user, SYSTEM and Administrators, with readback verification. Windows ACL behavior still needs native platform validation.

Any process running as your user can read these keys. Claude injects `ANTHROPIC_AUTH_TOKEN` into child processes, including commands, hooks and MCP servers. Exclude agent config directories from cloud sync, backups and dotfiles repositories. Use server-side quota limits, rotate tokens, and revoke old keys on the server. Local file permissions cannot stop malicious code running as you.

Keys are resolved only in main. IPC returns masks, fingerprints and status; previews and rollback previews suppress credentials. Provider IDs are generated in main and restricted to lowercase letters, numbers and hyphens, at most 32 characters. Unknown IPC fields, including URL/host/origin fields, are rejected.

## Files

| Tool | Projection | Startup |
|---|---|---|
| Codex | User `config.toml`: `[model_providers.swift]`, `name="swift-client"`, `base_url="<origin>/v1"`, `wire_api="responses"`, `experimental_bearer_token`; ownership marker above table | `codex --profile swift` |
| Codex profile | `<CODEX_HOME>/swift.config.toml`: only `model` and `model_provider="swift"` | Default provider stays unchanged unless “Set as Codex default” is selected |
| Claude | `<CLAUDE_CONFIG_DIR>/settings.json`: `env.ANTHROPIC_AUTH_TOKEN`, origin without `/v1`, model aliases, custom option and `SWIFT_CLIENT_MANAGED` | Normal Claude startup |

Default directories are `~/.codex` and `~/.claude`. `auth.json` is checked for existence only, never read or written. No `ANTHROPIC_API_KEY` is written. Startup checks beta.1 helper references, `model_providers.pa` (including `.auth`), old provider selections and legacy profiles. A native migration plan lists affected paths and requires confirmation before writing. Migration strips references, removes obsolete `userData/bin/pa-key` (and `.cmd`), and discards legacy profile and ownership records so tokens must be selected again. Legacy originals cannot be inherited by a new attachment. Cancellation leaves files untouched. Private snapshots are retained for recovery. No helper is installed; `packages/pa-key` is removed and RunAsNode is disabled.

Claude main/small models start as configurable placeholders. Preview is allowed, apply and paid checks refuse placeholders. Claude's model selector supports the opus/sonnet/haiku aliases and one custom option, not an arbitrary catalog.

Writes use atomic replacement, fingerprints, cooperative locks, first-write backups, rolling snapshots and an operation journal. Agent processes do not honor our locks; fingerprint checks reduce but cannot eliminate concurrent-edit races. Claude settings must be strict JSON. Unsafe TOML layouts are refused rather than rewritten destructively.

## Checks and billing

L0 verifies key-file permissions and compares credential fingerprints with config. L1 calls free `GET /v1/models`. L2 makes two paid requests per harness: nonstream and stream, with output cap 16 tokens. Before L2, the dialog shows request count, model, token cap and cost estimate. An estimate comes from numeric, bounded `/api/pricing` data or bundled `pricing.json` (with its date); unknown cost requires an extra checkbox. Quotes expire after five minutes and are single use. Paid calls never retry automatically. Limits: six paid requests per provider per ten minutes; ten free calls per minute. Cumulative request estimates are stored without credentials in `harness/test-usage.json`.

**L3 execution is currently refused (`harness-token-cap-unverified`)** because the real CLI commands have no verified hard request/token cap. Do not represent the L2 quote as a bound on an arbitrary agent run. Verifying a safe L3 limit remains outstanding.

All connectivity HTTP uses core's HTTP client, manual redirects and omitted browser credentials. Every 3xx, including pricing redirects, is refused. API shapes (`/v1/models`, `/api/pricing`, `/api/status`, `/v1/messages`, `/v1/responses`) are assumptions: **TODO verify after rain recovers**. No live paid API validation was performed.

## Cleanup and release checks

Detach removes the selected harness’s managed projection and its key-containing backups. The provider key is removed once no harness still uses it. A second detach is a no-op. Deleting an unused provider must not detach another provider. Windows uninstall invokes guarded cleanup using a one-use nonce; ordinary and second-instance invocations do not trigger cleanup. Per-user installation means another process as the same user can forge this guard and cause denial of service.

Before deleting the macOS app, detach from the Harness page. Otherwise manually remove `[model_providers.swift]`, `swift.config.toml`, and Claude's managed `env` fields, then revoke the token server-side. Removing the app alone leaves plaintext credentials usable.

Release CI extracts each installer’s `app.asar` with `@electron/asar` and checks committed origin, strict IPC field snapshot, own-module URL/environment policy using esbuild metafiles, and absence of smoke hooks. Third-party dependencies are excluded from the own-module scan.


## Migration limitations and manual keychain cleanup

Old OS keychain credentials are never read or automatically imported. This release does not expose a settings cleanup action; delete beta.1 entries manually using macOS Keychain Access, Windows Credential Manager, or your Linux Secret Service manager. Match the service **portable-agent** and accounts `<profileId>/claude`, `<profileId>/codex`, or `<profileId>/pi` (often `default/<harness>`); delete only entries you recognize. Revoke obsolete tokens on the old server too. Migration removes the local helper after confirmation, but does not revoke server tokens. Agent `auth.json` files remain untouched.

Apply tightens directory permissions to 0700 and configuration files to 0600 (or protected Windows ACLs). Detach restores managed values and, where possible, original bytes, but **does not restore previous permissions**. Private state and backups may contain the original Claude token for restoration and must be excluded from sync too.

H4 residual risk: project-level Claude checks inspect only `.claude/settings*.json` under the process working directory. A desktop app’s cwd is usually not the user’s project, so absence of a warning does not establish that project overrides are absent. Inspect project and managed settings before running Claude; the app does not scan arbitrary project trees.

The dev CLI uses provider `swift-cli`, `swift-cli.config.toml`, Codex marker `managed by swift-cli`, and Claude marker `SWIFT_CLI_MANAGED`. It refuses to apply over desktop-owned configuration and vice versa. Each client only recovers ownership from its own marker. Detach in the owning client before switching.
