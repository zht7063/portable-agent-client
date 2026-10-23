# Upstream compatibility (compat.json)

`compat.json` pins the new-api release whose web frontend is vendored (M2) and defines which servers the client accepts.

| Field | Value | Meaning |
|---|---|---|
| `tag` / `commit` | `v1.0.0-rc.46` / `7d8b9126…` | Upstream snapshot. |
| `minServer` | `v1.0.0-rc.46` | Oldest accepted server (**provisional** = the pin; older servers are untested until the M7 matrix). |
| `maxServerTested` | `v1.0.0-rc.46` | Newest verified server (M3: official rc.46 release binary, `scripts/integration-local-newapi.sh`); `null` means the same as `tag`. |
| `policy` | `same-minor-line` | Accept servers ≥ minServer on the same major.minor line. Newer-than-tested servers are accepted with a warning; other lines are refused. (`exact` is also supported.) |

`bun run compat` validates the file. `node scripts/compat-check.mjs --server v1.0.0-rc.47` evaluates a given server version. Upgrading the pin is a deliberate PR (M2 `scripts/update-upstream.sh`).

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
| network error | `unreachable` | same (re-checked on server change / restart) |
| `turnstile_check: true` | — | login blocked with a message (the Turnstile widget cannot load under the renderer CSP) |
| OAuth / OIDC / WeChat / Telegram / passkey enabled | — | message; flags are rewritten to `false` in the `/api/status` the renderer sees so upstream hides those buttons |
| `http://` server | — | warning only (plan §9.6 undecided; default = warn) |

The runtime check and `scripts/compat-check.mjs` use the same policy semantics (`classify` == `serverCompat`;
`apps/desktop/test/proxy.test.ts` checks a version table for both policies; `not-new-api` corresponds to `incompatible`).
