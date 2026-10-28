# Upstream compatibility (compat.json)

`compat.json` pins the new-api release whose web frontend is vendored (M2) and defines which servers the client accepts.

| Field | Value | Meaning |
|---|---|---|
| `tag` / `commit` | `v1.0.0-rc.46` / `7d8b9126…` | Upstream snapshot. |
| `minServer` | `v1.0.0-rc.46` | Oldest accepted server (**provisional** = the pin; older servers are untested until the M7 matrix). |
| `maxServerTested` | `v1.0.0-rc.47` | Newest tested server: **rc.47, 人工实测（非 CI）/ manual live test, not CI, on 2026-10-28** (see below); earlier M3 verification used the official rc.46 release binary (`scripts/integration-local-newapi.sh`). `null` means the same as `tag`. |
| `policy` | `same-minor-line` | Accept servers ≥ minServer on the same major.minor line. Newer-than-tested servers are accepted with a warning; other lines are refused. (`exact` is also supported.) |

The pin (`tag`/`commit`, the vendored web snapshot and the proxy allowlist) stays at **rc.46**; only the tested ceiling moved to rc.47. `minServer` is unchanged.

`bun run compat` validates the file. `node scripts/compat-check.mjs --server v1.0.0-rc.47` evaluates a given server version. Upgrading the pin is a deliberate PR (M2 `scripts/update-upstream.sh`).

## Manual live test of server v1.0.0-rc.47 (2026-10-28) — 人工实测（非 CI）/ manual, not CI

The basis for `maxServerTested = v1.0.0-rc.47` is the manual test below, run by hand by the engineer; **no CI run covers it**.
The manual-only `compat.yml` workflow only checks the credential-free `/api/status` of the official Docker image and does not prove
login/chat/refresh behaviour. A sanitized record (status codes, flags and counts only; no tokens, cookies, keys or bodies) is kept
**outside the repo** at `/workspace/engineer/evidence/compat-rc47-2026-10-28.txt` (the refresh/Origin evidence is in
`/workspace/engineer/evidence/refresh-origin-2026-10-28.txt`).

Run on 2026-10-28 (Asia/Singapore) against the production server `https://flowpier.top`, which reports `v1.0.0-rc.47` in
`/api/status`, using a throwaway test account and the client's own main-process code (`ServerProxy` + `checkServer` from
this branch with the updated `compat.json`); no credentials were logged or committed:

| Check | Result |
|---|---|
| `checkServer` | verdict `ok`, `allowLogin: true`, `serverVersion: v1.0.0-rc.47`, no unsupported-login flags, no Turnstile, no messages |
| Login (`POST /api/user/login` via `ServerProxy`) | 200 `success: true`; access token returned to the renderer only as an opaque handle; no `Set-Cookie` visible to the renderer; refresh cookie held in the main-process jar |
| Session (`/api/user/self`, `/api/token/`) | 200; token keys masked |
| Models (`/api/user/models`) | 200, 2 models listed |
| Playground chat, stream (`/pg/chat/completions`, `stream: true`) | 200 `text/event-stream`, 14 JSON events, none malformed, `[DONE]` seen |
| Playground chat, non-stream | 200, `finish_reason: stop`, usage reported |
| Refresh (`POST /api/user/auth/refresh` via `ServerProxy`) | 200 `success: true`, new access token returned as an opaque handle (requires the pinned-Origin fix, PR #12; without it the server answers 403 `AUTH_ORIGIN_FORBIDDEN`) |
| `/v1/models` through the proxy | 403 (not on the allowlist, as designed) |

Not covered: older servers (`minServer` stays provisional), OAuth/passkey/Turnstile flows, payments. The Docker matrix entry for rc.47
(`compatMatrix`) carries a digest verified on 2026-10-28 (Docker Hub / registry lookup, not a run). No `compat.yml` run is recorded in this file; a later manual run is reported on the PR.

## Runtime check (M3, desktop main process)

At startup (and whenever the server URL changes) main calls the public `GET <server>/api/status` — no cookies, no
Authorization, redirects not followed, 10 s timeout — and caches the result in main only
(`apps/desktop/src/main/proxy/server-status.ts`):

| `/api/status` result | Verdict | Effect |
|---|---|---|
| `minServer` ≤ version ≤ `maxServerTested` | `ok` | proceed |
| same major.minor line as the pin, newer than `maxServerTested` | `untested` | warning dialog, login allowed (plan §4) |
| other major.minor line (`same-minor-line`), or ≠ pin (`exact`) | `incompatible` | error dialog; login blocked (needs a client with a new pin) |
| version older than `minServer` | `too-old` | error dialog; proxy refuses `/api/user/login`, `/login/2fa`, `/login/verify`, `/register`, `/auth/refresh` (403 `LOGIN_BLOCKED` with the reason, shown by the upstream UI as a toast) |
| not JSON / no `success` / unparseable `data.version` / non-200 | `not-new-api` | same as `too-old` |
| network error | `unreachable` | same; main retries in the background with exponential backoff (2 s doubling to 60 s, cancelled on server change) and re-checks immediately before any login request |
| `turnstile_check: true` | — | login blocked with a message (the Turnstile widget cannot load under the renderer CSP) |
| OAuth / OIDC / WeChat / Telegram / passkey enabled | — | message; flags are rewritten to `false` in the `/api/status` the renderer sees so upstream hides those buttons |
| `http://` server | — | warning only (plan §9.6 undecided; default = warn) |

The runtime check and `scripts/compat-check.mjs` use the same policy semantics (`classify` == `serverCompat`;
`apps/desktop/test/proxy.test.ts` checks a version table for both policies; `not-new-api` corresponds to `incompatible`).
