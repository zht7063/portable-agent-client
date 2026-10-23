# Security tests (M7)

All run in `bun run test` (offline) and in CI.

| Area | File | What |
|---|---|---|
| Leak regression | `apps/desktop/test/security/leak-regression.test.ts` | proxy bodies/headers/errors, IPC results/errors on every channel: no full key, access token, cookie; Bearer in free text, raw 48-char keys in JSON/text, short masks in form bodies are masked; renderer-supplied credentials never forwarded; dispatch guard blocks a handler that returns a key |
| Guards | `.../guards.test.ts` | exact CSP (no eval/inline/remote/wildcard) on every app-protocol response; navigation/window.open decisions; all permissions denied, downloads cancelled, webviews blocked; locked webPreferences (`devTools` off when packaged); IPC only from our main frame |
| Surface snapshots | `.../surface-snapshots.test.ts` | exact `window.pa` surface and IPC channels; proxy allow/deny lists, masked-save paths; key-taking relay endpoints unreachable |
| Input validation | `.../input-validation.test.ts` | path traversal fuzz (app protocol, proxy, harness fs incl. symlinks), masked admin saves refused, server URL validation |
| Bundle scan | `scripts/scan-bundle.mjs` + `.../scan-bundle.test.ts` | built bundles: no secret shapes (private keys, sk- keys, GitHub/Slack/AWS tokens, Bearer literals, unprefixed 48-char new-api keys assigned to a key-like name with mixed case + digit — hashes/single-case IDs never match; plus any bare 48-char high-entropy string without keyword context, same heuristic as sanitize, suppressible only via `scripts/scan-bundle-allowlist.json` = sha256 AND path glob (asar-internal form `<x.asar>:<inner>`) + justification; `PA_SCAN_ALLOWLIST` override refused in CI (`CI`/`GITHUB_ACTIONS` = true or 1, case-insensitive), findings print sha256 not the string) in .js/.json/.map/.html/.txt/.svg under `dist/` and `release/`, including files inside `.asar` archives (in-memory parser); main/preload (own code, not node_modules): no weakened webPreferences, `openDevTools`, remote module, raw `ipcRenderer` exposure. Prints file/rule/offset only |
| CI policy | `.../ci-policy.test.ts` | workflow stays read-only, SHA-pinned, secret-free, publish-free |
| Renderer DOM | `src-local/__tests__/security-dom.test.tsx` (local pages run) | after key actions the DOM holds no key/token/cookie, no link carries a key, renderer never fetches a key |
| Copy-curl | `apps/desktop/test/keys.test.ts` | origin chosen by main, key charset + quoting (Aegis M5 MUST 1/2) |
| Packaging | `apps/desktop/test/window-policy.test.ts`, `test/packaging/*` | packaged menus/devTools, reproducible source tarball, placeholder build check |

Changing CSP, the preload surface or the allowlist requires updating the snapshot test and this file in the same commit.

## Threat model (response masking)

- **Trusted upstream** (your own new-api server, honest but leaky: error messages echoing requests, admin pages
  listing secrets): masking is designed for this. Known secrets are always masked; unknown key-shaped values are masked
  heuristically.
- **Untrusted / malicious upstream** (compromised or hostile server): the server already holds every secret it could
  leak and controls what the UI renders. Masking does **not** stop it from showing an *unknown* value to the user; it
  only guarantees that values the client knows to be secret are never shown.

Guarantees:

1. **Known secrets are always masked**, in every JSON string, text body and SSE line, including inside header-valid
   `data:image` payloads and JSON-in-a-string user `setting`. Known = every access token in the vault, the token sent on
   the request, and every value (>= `MIN_KNOWN` = 12 chars) found under a secret-named field anywhere in the same
   response (pass 1 of `sanitizeJson`), replaced by exact match in pass 2 before any heuristic.
2. **Unknown secrets are masked heuristically** (`sk-…`, JWT, `otpauth://`, `Bearer …`, 32–128 char high-entropy runs).
   Best effort; see limitations below.
3. **SSE** (`text/event-stream`, playground) is sanitised line by line (`sseSanitizer`): each complete line is masked
   and forwarded at once (latency = one line); partial lines are buffered; a line > 64 KiB is flushed in pieces cut at
   a non-key character with a 256-char tail so no key is split. Decision: the earlier pass-through was not
   intentional-by-design (model output can echo prompts and upstream errors), so it was fixed.
4. **Masked values are never saved back**: a request body carrying our mask (`**********` / `ab****yz`) or a handle to
   a secret-round-tripping endpoint is refused with 409 before leaving main (see the field list below).

## UI fields that can display base64 / key material (vendored new-api web, rc.46)

| Page / endpoint | Field(s) | Masked-save guard |
|---|---|---|
| Channels `/api/channel` | `key` (incl. Vertex service-account JSON with PEM `private_key`, AWS `AK\|SK\|region`, multi-key lists) | yes (`/api/channel`) |
| Payment settings `/api/option` | `WaffoPrivateKey`, `WaffoSandboxPrivateKey`, `WaffoPublicCert`, `WaffoSandboxPublicCert`, `StripeApiSecret`, `StripeWebhookSecret`, `CreemWebhookSecret` | yes (`/api/option`) |
| Waffo Pancake `/api/option/waffo-pancake/{pair,save}` | `private_key` (PEM) | yes (`/api/option`) |
| Auth settings `/api/option` | `GitHubClientSecret`, `LinuxDOClientSecret`, `TurnstileSecretKey`, SMTP password / certificate options | yes (`/api/option`) |
| Custom OAuth `/api/custom-oauth-provider` | `client_secret` | yes |
| Deployments `/api/deployments` | `registry_secret`, `secret_env_variables` | yes |
| Profile notifications `PUT /api/user/setting` | `webhook_secret` (inside JSON `setting`) | **added in this round** |
| Profile `PUT /api/user/self` | `password` | yes (password fields only) |
| Login `GET /api/user/login/encryption-key` | `public_key` (RSA PEM, public) | n/a — passed through intact (only known values masked) because masking breaks password encryption |
| Any response | `ETag` header | header values are now `maskString`-ed |

Read-only displays (passkey public keys, Gemini thought signatures) are not saved by the client.

## Known limitations

- **A malicious upstream can deterministically smuggle UNKNOWN keys** inside a header-valid `data:image` payload
  (bounded by `+`/`/`/`=`), or by encoding/splitting them (base64, short pieces, homoglyphs). Only known secrets are
  guaranteed masked there. This is by design (see threat model): the client cannot defend secrets it does not know
  against the server that holds them.
- **Unprefixed keys shorter than 32 characters** are not detected (scan-bundle) or masked (sanitize `looksLikeBareKey`):
  below that length the random-vs-identifier heuristic produces too many false positives. `sk-` keys are covered from
  16 characters; values in secret-named fields are masked regardless of shape.
- **Base64-encoded keys** (a key wrapped in base64, e.g. inside a Basic auth header or an encoded blob) are not
  decoded and therefore not detected/masked for now.
- **Base64 (sanitize)**. Plain text uses only `[A-Za-z0-9_-]` as run delimiters, so a key next to `/ + =` is masked
  (`https://h/K`, `/v1/K/x`, `K/R…`, `R…+K`, `AAAA/K+R…`, `{"sig":"R…+K"}`, `abc==K`, …). There is **no** exception
  for unprefixed base64 (the former block heuristic was bypassable and was deleted). The single exception is a
  word-boundary `data:image/<subtype>;base64,` whose payload is valid base64 (alphabet, <= 2 trailing `=`, length
  % 4 == 0, >= 64 chars, no line breaks) **and** decodes to a PNG/JPEG/GIF/WebP/SVG header. **Not masked** (pinned by
  tests in `bare-key-masking.test.ts`): inside such a verified payload, any key-shaped run is left alone when it is
  bounded by `+`, `/`, `=`, or the payload's own start/end — in practice the whole verified payload is untouched,
  including a key glued to its end when the total length stays valid. A key after the payload separated by any
  non-base64 char (`"`, space, `>`) is masked; payloads that are invalid or lack the header are plain text.
- **False positives on ordinary base64** (`apps/desktop/test/security/base64-fp.test.ts`, 10k deterministic blobs:
  random/PNG/JPEG/gzip bytes, unwrapped or wrapped at 64/76, bare or as `data:image`). Altered = output != input; it
  only over-masks (a 32+ high-entropy run becomes `xxxx**********xxxx`, display corruption), never leaks.

  | blobs | count | altered |
  |---|---|---|
  | png as `data:image` | 647 | 7.57% (payloads < 64 chars, plain text) |
  | jpeg as `data:image` | 725 | 2.21% |
  | unprefixed random (unwrapped / wrap 64 / wrap 76) | 1973 / 988 / 1027 | 87.99% / 88.06% / 89.78% |
  | unprefixed png / jpeg / gzip (unwrapped) | 661 / 649 / 990 | 95.16% / 89.98% / 96.36% |
  | by length: <64 / 64-127 / 128-511 / >=512 | 1063 / 732 / 2143 / 6062 | 36.31% / 71.31% / 84.04% / 86.77% |
  | all | 10000 | 79.69% |

  Rationale: unprefixed base64 cannot be told apart from text that embeds a key without being bypassable, so it is
  treated as plain text and over-masked. Bench bounds: png(data:image) <= 9%, jpeg(data:image) <= 3%, all <= 82%.
- The high-entropy heuristic (upper + lower + digit, >= 6 class switches, not hex/UUID/single-case/identifier+number)
  can miss keys that happen to look low-entropy and can flag non-secrets; scan-bundle false positives go into
  `scripts/scan-bundle-allowlist.json` (sha256 + path glob + justification). Inline images in renderer text: a
  `data:image` with a payload < 64 chars or without a recognised header may be over-masked (display only).
