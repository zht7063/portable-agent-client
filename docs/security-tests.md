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
  only guarantees that values the client knows to be secret are never shown. In particular, a forged
  `data:image/...;base64,` payload or a forged `data[i].b64_json` with a valid PNG/JPEG/GIF/WebP(/SVG for data:image)
  header **deterministically** carries any unknown key (placed between `+`/`/`/`=`) past the heuristics: those
  payloads are exempt by design so real images are not corrupted.

Guarantees:

1. **Known secrets are always masked**, in every JSON string, text body and SSE line, including inside header-valid
   `data:image` payloads and JSON-in-a-string user `setting`. Known = every access token in the vault, the token sent on
   the request, and every value (>= `MIN_KNOWN` = 12 chars) found under a secret-named field anywhere in the same
   response (pass 1 of `sanitizeJson`), replaced by exact match in pass 2 before any heuristic.
2. **Unknown secrets are masked heuristically** (`sk-…`, JWT, `otpauth://`, `Bearer …`, 32–128 char high-entropy runs).
   Best effort; see limitations below.
3. **SSE** (`text/event-stream`, playground) is sanitised line by line (`sseSanitizer`): each complete line is masked
   and forwarded at once (latency = one line); partial lines are buffered. Lines are **never cut** (a cut inside a
   `data:image` payload would break span recognition and either corrupt the image or let a heuristic decision differ):
   a line may exceed 1 MiB (up to 32 MiB) only if it carries confirmed image payloads. Early, incremental check
   (`SseLineMeter`, UTF-8 bytes): the line starts `data: {` (or `data:{`) and an image span starts right after
   `"b64_json":"` or `data:image/<type>;base64,` (the first within 8 KiB) whose first 24 base64 chars decode to an
   image header; text outside spans is limited to 1 MiB, so a fake marker is rejected after ~1 MiB. Final check, when
   the line is complete and > 1 MiB: the spans are recomputed with the **same predicates as the buffered-body path**
   (`isB64JsonImage` on top-level `data[i].b64_json`, as in `sanitizeJson`; `isDataImagePayload` for `data:image`, as in
   `maskString`; a span containing a known value is not a span) and the bytes outside them must be <= 1 MiB. If
   that fails the line is dropped with `SSE_LINE_TOO_LARGE` directly; the text masker is never run over a giant line.
   **Buffer budget** (`SseBudget`, UTF-8 bytes of unflushed partial lines): per stream <= 32 MiB, process-wide across
   all concurrent SSE streams <= 64 MiB. There is no cumulative per-stream cap, so long sessions are never cut. When a
   reservation would exceed the global cap, the stream with the **largest** buffered usage (possibly not the
   requester) is ended with `event: error` / `SSE_BUFFER_LIMIT` and its bytes released, repeatedly, until the request
   fits; if the requester itself is the largest, it is the one ended. A stream over its own 32 MiB also gets
   `SSE_BUFFER_LIMIT`. A stream's bytes are released on line flush, stream end, error frames, exceptions thrown while
   sanitising (try/catch release, then rethrow) and consumer cancel / upstream abort; `sseBudget.held` returns to 0.
   **Idle timeout**: while a stream holds a partial line, no new data for 120 s (`SSE_IDLE_MS`) ends it with
   `event: error` / `SSE_IDLE_TIMEOUT` and releases its bytes, so a stream dropped without cancel cannot pin budget.
   The budget references streams only through `WeakRef`s; a `FinalizationRegistry` releases the bytes of a stream
   that is garbage-collected without end/cancel (fallback). The idle timer's callback is module-level and holds only
   a `WeakRef` to the stream (timer `unref()`ed), so a dropped stream with a non-empty buffer stays collectable and
   the GC fallback can release it before the timeout (forced-GC test). The timer is armed only while a half line is buffered,
   so quiet sessions between complete lines are never cut.
   **Frontend note**: several concurrent large image responses (each up to 32 MiB buffered) can together hit the
   64 MiB global budget; the largest stream then ends with `SSE_BUFFER_LIMIT`. This is a transient condition: the
   UI should show the error and offer a retry. This repo has no client-side handler for these SSE error codes (the
   playground UI is upstream's), so the retry hint is a documented follow-up for the frontend, tracked in
   https://github.com/zht7063/portable-agent-client/issues/1.
   Over-long lines end the stream with `event: error` / `SSE_LINE_TOO_LARGE`. `data:image` spans are found with a
   linear scan (no backtracking regex), so multi-MB images pass byte-identical.
   **`b64_json` exception (Iris decision; no generic base64 exception).** In a JSON body, or the JSON of an SSE
   `data:` line, a string under the exact key `b64_json` of an object that is an element of the **top-level** `data`
   array (`data[i].b64_json`, the image-generation response shape) is a confirmed image payload when it is valid
   base64 (alphabet, length % 4 == 0, <= 2 trailing `=`, >= 64 chars) and decodes to a PNG/JPEG/GIF/WebP header (SVG
   not accepted). Same rules as a `data:image` payload. Decided: top-level `data[i]` only, not any depth (other
   depths, other field names incl. `b64`/`image`/`b64_JSON`, `data` as an object, free text, invalid base64 are plain
   text). Known values are exact-replaced first; a payload containing one is not exempt. SSE lines are not
   re-serialised: only the exact quoted value is exempted, so lines stay byte-identical (a value written with JSON
   escapes such as `\/` is not matched and falls back to plain text). Decision: the earlier pass-through was not
   intentional-by-design (model output can echo prompts and upstream errors), so it was fixed.
4. **Paths are decided on their decoded form.** The vendored frontend puts `encodeURIComponent()` values in path
   segments (session ids, plugin keys/versions, task/container ids, node names), so `%` cannot be refused outright.
   Each segment is decoded once; malformed escapes, a decoded `%` (double encoding), `/`, `\\`, control chars or dot
   segments are refused (400). DENY, the allowlist, the 409 guards and login/logout gates all see the decoded path, and
   its canonical re-encoding is what is sent upstream. The query string is forwarded verbatim (it may legitimately
   carry `%`) and is never used for decisions.
5. **Masked values are never saved back**: a request body carrying our mask (`**********` / `ab****yz`) or a handle to
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
| Login `GET /api/user/login/encryption-key` | `public_key` (RSA PEM, public) | n/a — only the top-level `data.public_key` on that path, only if it has a PUBLIC KEY PEM header, `crypto.createPublicKey` parses it, and its DER re-export (`spki`, or `pkcs1` for RSA PUBLIC KEY) equals the PEM body byte for byte (no extra bytes); passed through intact (known values still masked) because masking breaks password encryption |
| Any response | `ETag` header | header values are now `maskString`-ed |

Read-only displays (passkey public keys, Gemini thought signatures) are not saved by the client.

## Known limitations

- **A malicious upstream can deterministically smuggle UNKNOWN keys** inside a header-valid `data:image` payload
  (bounded by `+`/`/`/`=`), or by encoding/splitting them (base64, short pieces, homoglyphs). Only known secrets are
  guaranteed masked there. This is by design (see threat model): the client cannot defend secrets it does not know
  against the server that holds them.
- **Known values come only from SECRET_FIELDS.** A key under a field name not in `SECRET_FIELDS` (e.g. a custom
  `upstream_cred`), or one that only appears in free text, is not collected as a known value; it is masked only if the
  heuristic catches it (so not inside a header-valid `data:image` payload).
- **A malicious upstream can also smuggle unknown keys inside a header-valid `data[i].b64_json`** (same as
  `data:image`; only known values are guaranteed masked there).
- **A known key inside a data:image / b64_json payload corrupts that image** (accepted): after exact replacement the payload is no longer
  valid base64, so the rest of the span is treated as plain text and over-masked.
- **Bare-run scanner**: a hand-written linear scan (no regex backtracking); a single run longer than 1 MiB is masked
  entirely. The `sk-`, JWT, `otpauth://` and `Bearer` shapes and the error-text long-run mask are also linear
  scanners: the previous regexes overflowed the regexp stack on 16 MB runs (RangeError). JSON bodies nested deeper
  than 256 levels (`MAX_JSON_DEPTH`, also inside `setting`) are refused with 502 `TOO_DEEP` instead of overflowing
  the recursive walk. The request-side masked-save guard (`containsMaskedValue`, incl. JSON-in-a-string option
  values) uses the same limit and refuses deeper request bodies with 400 `TOO_DEEP` (not forwarded). Tests: `glued-keys.test.ts` "large / deep inputs".
- **Provider ID prefixes** are exempt from the heuristic only for these exact shapes (`ID_PREFIX_SHAPES`); a prefix
  followed by an unknown 48-char key never matches (tests: 15/15 masked per prefix, 200 synthetic real-shape ids per
  prefix 0 masked). Known values are exact-replaced first regardless.

  | Prefix | Tail shape | Source / example |
  |---|---|---|
  | `chatcmpl-` | 29-31 base62 | OpenAI Chat Completions responses, e.g. `chatcmpl-B9MBs8CjcvOU2jLn4n570S5qMJKcT` (29; up to 31 allowed) |
  | `cmpl-` | 29 base62 | OpenAI legacy Completions, e.g. `cmpl-7QmVI15qgYVllxK0FtxVGG6ywfzaq` |
  | `msgbatch_` | `01` + 22 base62 | Anthropic Message Batches, e.g. `msgbatch_013Zva2CMHLNnXjNJJKqJ2EF` |
  | `resp_` | 48 lowercase hex | OpenAI Responses API, e.g. `resp_67ccd2bed1ec8190b14f964abc0542670bb6a6b452d3795b` |
  | `msg_` | `01` + 22 base62 (Anthropic) or 24 base62 (OpenAI Assistants) | Anthropic Messages API, e.g. `msg_013Zva2CMHLNnXjNJJKqJ2EF` |
  | `toolu_` | `01` + 21-24 base62 | Anthropic tool use docs, e.g. `toolu_01A09q90qw90lq917835lq9` |
  | `call_` | 24 base62 | OpenAI tool_calls ids |
  | `asst_` | 17-24 base62 | OpenAI Assistants (24); community example `asst_58fDQ7d8AJHDJy8dv` (17) |
  | `thread_`, `run_`, `step_` | 24 base62 | OpenAI Assistants ids |
  | `file-` | 22-24 base62 | OpenAI Files, e.g. `file-6F2ksmvXxt4VdoqmHRw6kL` (22), older ids 24 |

  All tails are < 32 chars, so no prefix can carry a 48-char key. Removed (shape not pinned down from a reliable
  source): `batch_`, `ftjob-`, `req_`. OpenAI
  documents ids as opaque and liable to change; a provider changing a shape makes those ids get masked (fail closed).
- **Key formats**: new-api tokens are 48-char base62 (no `-`/`_`), which the run/segment heuristic covers. The
  remaining gap is third-party keys made of short hyphen/underscore-separated segments (no single segment of >= 32
  random chars), which are only masked when the whole run is <= 128 chars and looks random, or when known.
- **Bare runs** have no upper length bound: a run of `[A-Za-z0-9_-]` is masked whole if it is <= 128 chars and
  looks random, otherwise each `-`/`_`-separated segment is checked (so `uuid-K`, `K_<long>`, `req-<digits>-K` are
  masked). Not caught: a key that itself contains `-`/`_` AND is glued into a run > 128 chars with no segment of
  >= 32 random chars (adjacent-segment joins are not tried). UUIDs are exempt only in lowercase hex.
  ID probes (`glued-keys.test.ts`): provider ids of the exact shapes above are unchanged (`run_<32 mixed>` is now masked); lowercase UUIDs, request ids, snake/kebab/camel/
  CONSTANT identifiers and model names are unchanged. The base64 FP bench is unchanged by these changes (all 79.69%).
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

## Verification (environment and scope)

Reviewed state: branch `feat/m7` (no PR). Commands, from the repo root with a temporary `HOME` (Node 22.19, bun):
`bun run typecheck && bun run lint && bun run test && bun run compat && bun run licenses && node scripts/scan-bundle.mjs`.
CI (`.github/workflows/ci.yml`) runs the same plus `bun run install:web` and `bun run build:prod` before the scan,
with `PA_REQUIRE_WEB_DEPS=1`.

- **Main vitest suite** (`vitest run`, all workspaces): at this revision 769 passed / 3 skipped in a working tree
  that has been built, and **768 passed / 4 skipped in a clean checkout**. The difference is one test:
  `apps/desktop/test/packaging.test.ts` "stage: linux has no native modules ..." is `skipIf(!built)` and runs only
  when `apps/desktop/dist/main/index.cjs` and `apps/desktop/dist/renderer` exist (after `bun run build` /
  `build:prod`). The other 3 skips are always skipped without opt-in: the offline harness e2e tests
  (`packages/harness/test/harness-{codex,claude,pi}-e2e.test.ts`) need `PA_HARNESS_E2E=1` plus `CODEX_BIN` /
  `CLAUDE_BIN` / `PI_BIN`. (Aegis' 767/4 vs our 768/3 on 2f1c0f3 is this same packaging test.) No test depends on
  `--expose-gc`: the forced-GC tests enable `gc` themselves via `v8.setFlagsFromString` + `vm.runInNewContext`.
- **Second suite (37/37 in 5 files)**: the second half of `bun run test`, `scripts/test-local-pages.sh --no-install`:
  typecheck + oxlint + vitest for our `src-local` pages and patched upstream files inside the prepared new-api web
  tree (`.build/new-api-web`). It needs `bun run install:web` (network) first; without those deps it prints
  `local-pages: SKIPPED` and exits 0, except in CI (`PA_REQUIRE_WEB_DEPS=1`), where that is a failure.
- **Bundle scan**: `node scripts/scan-bundle.mjs` over `apps/desktop/dist` and `apps/desktop/release` (incl. `.asar`);
  "clean" = no findings.
- **Base64 false-positive metric (79.69%)**: `apps/desktop/test/security/base64-fp.test.ts` (part of the main suite;
  `PA_B64_BENCH=1` prints the per-kind table). Dataset: 10,000 deterministic blobs (mulberry32, seed `0x5eed`) of
  random / PNG-headed / JPEG-headed / gzip bytes, 8-~2400 bytes, base64-encoded, unwrapped or wrapped at 64/76
  columns, about a third of PNG/JPEG ones as `data:image/...;base64,` URIs. Metric: share of blobs for which
  `maskString(text) !== text` (any alteration). 79.69% overall is expected: unprefixed base64 is deliberately plain text
  (high-entropy runs look like keys); the exempt `data:image` forms are 7.57% (PNG) / 2.21% (JPEG), the remainder
  being payloads whose random bytes happen to contain `sk-`/JWT/Bearer-like or out-of-span shapes. The test pins
  upper bounds so a regression fails it.
