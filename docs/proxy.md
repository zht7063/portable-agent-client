# Main-process server proxy (M3)

Plan v2 §2 / §4 / §7-M3. Code: `apps/desktop/src/main/proxy/`; wiring in `src/main/index.ts`.

## Request path

```
renderer fetch('/api/...')  →  pac://app/api/...  →  protocol.handle (main)  →  ServerProxy.handle
  → normalisePath (no .., no %2e/%2f/%5c/%00, no //host)     → 400
  → allowlist (deny list, then path+method rules)            → 403 / 405
  → server configured?                                        → 503 NO_SERVER
  → login gate (/api/status verdict, Turnstile)               → 403 LOGIN_BLOCKED (+ reason)
  → request body ≤ 8 MiB                                      → 413
  → Node fetch(<configured origin><path>?<query>, redirect: 'manual')
  → Set-Cookie → main-only CookieJar (never returned)
  → 3xx: same-origin → relative Location passed back (not followed); cross-origin → 502
  → JSON/text ≤ 32 MiB → sanitised; text/event-stream (/pg playground) streamed through
  → response headers allowlisted; app:// CSP + hardening headers re-applied
```

- **Origin pinning**: the target is always `new URL(path + search, configuredOrigin)` and re-checked; the renderer
  cannot name a host. Changing the server URL discards the jar, the token vault and the cached check.
- **Allowlist** (`allowlist.ts`): top-level `/api` segments used by the rc.46 frontend (derived from upstream
  `router/api-router.go`), read-only public pages GET/HEAD only, `/pg/{chat/completions,images/generations,responses}`
  POST. Denied: `/v1`, `/mj` relay paths (need API keys), webhooks/payment callbacks, `/api/oauth/*` (except email
  bind), passkey login.
- **Request headers** forwarded from the renderer: `accept`, `accept-language`, `content-type`, `cache-control`,
  `x-auth-session`, `x-security-proof`, `if-none-match`, `if-modified-since`. Cookie / Authorization / Origin /
  Host / `New-Api-User` from the renderer are dropped. (rc.46 authenticates the frontend with
  `Authorization: Bearer <access token>` + an HttpOnly refresh cookie on `/api/user/auth`; it no longer needs
  `New-Api-User`, so none is sent.)
- **Response headers** passed back: `content-type`, `content-disposition`, `content-language`, `cache-control`,
  `last-modified`, `etag`, `retry-after` (+ rewritten same-origin `location`). Never `Set-Cookie`.

## Credentials stay in main

| Credential | Where it lives | Renderer sees |
|---|---|---|
| Refresh cookie `new_api_refresh` (HttpOnly, path `/api/user/auth`), hint `new_api_has_session` | `CookieJar` in main; persisted encrypted with `safeStorage` to `<userData>/server-session.bin` (memory-only if encryption is unavailable) | nothing (`document.cookie` is empty; no Set-Cookie ever reaches app://) |
| Access token (login / 2FA / refresh bundles) | `AccessTokenVault` in main memory (latest two) | opaque handle `pac-h.<random>`; main swaps it for the real token on the way out. A forged/unknown bearer is dropped. |
| API keys (token list, key reveal, channel keys…) | server only | masked `abcd**********wxyz` (same shape as upstream `MaskTokenKey`) |

The handle is only meaningful to this proxy (it is never sent to the server), so it is a reference to the main-held
session rather than a credential. The upstream frontend keeps it in memory only (zustand store, not persisted).

**Masking** (`sanitize.ts`, applied to every JSON response at any depth): auth bundles → handle; fields
`key/token/sk` when secret-shaped (`^(sk-)?[A-Za-z0-9_-]{32,}$` or `sk-…`; `/api/option` names like
`{"key":"SMTPServer"}` stay intact); always-masked fields `api_key, access_token, refresh_token, id_token, secret,
client_secret, password, totp_secret, backup_codes, qr_code_data, private_key, secret_key, credential(s),
authorization, cookie, webhook_secret, session_secret`; secret-shaped strings anywhere (`sk-…`, JWT-like,
`otpauth://`). Non-JSON text bodies get the `sk-`/JWT pass.

Consequences (deliberate): full keys are never visible in the client UI (see "Token → keychain (M4)"). Admin pages
that *display* secrets (channel keys, OAuth client secrets, SMTP password) show masked values; saving such a form is
refused by the proxy (below) — admins do secret edits in the server's web UI. 2FA **enrolment** (secret / QR / backup codes) is masked and therefore
must be done in the server's web UI; 2FA **login** works through the proxy.

## Login (plan option A)

The user signs in on the unmodified upstream `/sign-in` page. `POST /api/user/login` (optionally RSA-encrypted
password, `/login/2fa`, `/login/verify`) goes through the proxy; main stores the refresh cookie and the access token,
the renderer gets the sanitised bundle. Reload/restart: the upstream app calls `/api/user/auth/refresh`; main attaches
the refresh cookie from the jar. Logout (`/api/user/auth/logout`) clears jar + vault.

Unsupported in M3 (clear message, no implementation beyond the plan; plan §9.3 decides):
- **OAuth / OIDC / WeChat / Telegram / custom OAuth**: the provider redirects back to the *server's* web UI, which
  cannot hand a session to the client. Buttons are hidden (status flags rewritten); `/api/oauth/*` returns 403
  `OAUTH_UNSUPPORTED` with a message. The startup dialog lists the methods that are unavailable.
- **Passkey**: WebAuthn is bound to the server's RP ID; app:// cannot satisfy it → hidden + 403 `PASSKEY_UNSUPPORTED`.
- **Turnstile**: the widget script is blocked by the renderer CSP → login is refused with an explanatory message.

## Frontend patches

None needed for M3. Checked in the vendored rc.46 source: the auth store (`stores/auth-store.ts`) is in-memory only;
localStorage holds UI preferences, the public `/api/status` copy, the affiliate code and an auth-sync event
`{type, sid}` (session id, not a credential — useless without the main-held refresh cookie). The session-hint cookie
being invisible to the renderer only skips the optimistic boot refresh; route guards still call
`/api/user/auth/refresh` (upstream `resolveAuthentication`), so sessions resume after a restart.

## Server URL changes (Aegis review)

The configured origin decides where passwords, the session and API keys go. `config:set { serverUrl }` from the
renderer therefore requires a native main-process dialog (`confirmServerChange`: full new + current URL shown, Cancel
is the default; no dialog wired = refused). Only `http:`/`https:` URLs are accepted; re-saving the same URL does not prompt.
`PAC_SERVER_URL` (main-owned, dev) still seeds an unconfigured client.

## Token → keychain (M4)

Code: `apps/desktop/src/main/key-service.ts`, `ServerSession.mainApi`, IPC `keys:*` (preload `window.pa.keys.*`).

- The renderer sends only a **token id**. Main calls the standard API itself — `POST /api/token/:id/key` (and
  `GET /api/token/:id` for the name) — with the main-only session (jar cookie + latest access token from the vault).
  These responses are never sanitised-and-forwarded; they do not pass through the renderer proxy at all.
- `keys:store {tokenId, harness}` writes `sk-<key>` straight into the OS keychain: service = product
  `keychainService`, account `default/<harness>` (single profile in M4). A non-secret metadata file
  `<userData>/keychain-entries.json` records token id, name, masked key and time per entry.
- `keys:list` → `{available, backend, fallback?, entries:[{profileId, harness, tokenId, tokenName, maskedKey, storedAt, present}]}`.
- `keys:copy {tokenId}` → main writes the full key to the system clipboard; the response carries the masked key only.
  Aegis N1: main clears the clipboard after `clipboardClearSeconds` (config, integer 0..600, default 30, 0 = off) and on
  quit (`before-quit`/`will-quit`), only if it still holds that key (compared by SHA-256 in main; never logged).
- `keys:delete {harness}` removes the keychain entry + metadata.
- Harness apply in `command` key mode provisions the entry via the same path (`KeyService.ensure`: refetches only if
  the entry is missing or bound to another token); `pa-key default <harness>` then reads it (unchanged).
  The Codex channel probe also uses the main-session key fetch.
- Keychain unavailable (Linux without a Secret Service / `secret-tool`): `keys:store` refuses with an "use env key
  mode" message *before* fetching the key; nothing is written anywhere; `keys:list` reports `fallback: 'env'`.
- Every `keys:*` response still goes through the dispatch credential-leak guard.

## Masked admin saves are blocked (M4)

`POST/PUT/PATCH` to `/api/{channel,option,custom-oauth-provider,deployments}/…` whose body contains our mask
(`**********`, `xx****xx` as a whole value, also inside JSON-in-string option values) or an access-token handle is
answered `409 MASKED_SECRET_SAVE_BLOCKED` with a message to edit the setting in the server web UI; nothing is sent.

## Local integration (M3/M4)

`NEWAPI_BIN=<official rc.46 binary> PAC_M4=1 unshare -rn dbus-run-session -- scripts/integration-local-newapi.sh`
(loopback-only namespace, throwaway sqlite DB / account / gnome-keyring, temp HOME). The dev box has no
libsecret-tools, so the test-only `test/live/bin/secret-tool` shim (Python `secretstorage`) talks to the throwaway
gnome-keyring-daemon; the client code path (`SecretToolKeyring`, pa-key) is unchanged.
