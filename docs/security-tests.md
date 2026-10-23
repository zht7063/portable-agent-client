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

## Known limitations

- **Unprefixed keys shorter than 32 characters** are not detected (scan-bundle) or masked (sanitize `looksLikeBareKey`):
  below that length the random-vs-identifier heuristic produces too many false positives. `sk-` keys are covered from
  16 characters; values in secret-named fields are masked regardless of shape.
- **Base64-encoded keys** (a key wrapped in base64, e.g. inside a Basic auth header or an encoded blob) are not
  decoded and therefore not detected/masked for now.
- **Base64 spans** (sanitize). Plain text uses only `[A-Za-z0-9_-]` as run delimiters, so a key next to `/ + =`
  (`https://h/K`, `https://h/v1/K/x`, `path/K`, `/K end`, `K/x`, `K+`, `K=`, `x+K`, `abc==K`) is masked. The base64
  exception (runs bounded by `+ / =` or a line break are data, not keys) applies only inside a recognised span:
  1. `data:image/<subtype>;base64,` at a word boundary, payload valid base64 (alphabet, <= 2 trailing `=`,
     length % 4 == 0, >= 64 chars) whose decoded header is PNG/JPEG/GIF/WebP/SVG;
  2. an unprefixed block: a maximal base64-alphabet run (line wraps allowed), >= 64 chars, length % 4 == 0, containing
     `+` or `/`, with `+`/`/` density <= 1/16 (random base64 ≈ 1/32; URL paths have many short segments), not
     adjacent to `[A-Za-z0-9_.:%~@?&#=-]` (so nothing after `https:` or `host.tld` qualifies), and not starting with `/`
     unless >= 128 chars or an image header.
  Spans of >= 128 chars and image payloads treat their own edges as base64 boundaries too (otherwise e.g. every PNG's
  leading `iVBORw0KGgo…` run would be masked); 64-127-char blocks still mask a 32+ high-entropy run at their edge.
  Every other `data:` form (`data:,K`, `data:x,K`, `data:;base64,K`, `metadata:,K`, short/invalid/non-image payloads)
  is ordinary text. **Not masked**: a key inside a recognised span between `+ / =` / line breaks, or at the edge of a
  >= 128-char span (e.g. `K/` followed by >= 79 chars of low-separator path-like base64 alphabet with valid length).
- **False positives on ordinary base64** (`apps/desktop/test/security/base64-fp.test.ts`, 10k deterministic blobs:
  random/PNG/JPEG/gzip bytes, unwrapped or wrapped at 64/76, bare or as `data:image`): altered = output != input.

  | encoded length | blobs | altered |
  |---|---|---|
  | < 64 | 1063 | 36.31% (plain text by design: indistinguishable from a key) |
  | 64-127 | 732 | 8.33% |
  | 128-511 | 2143 | 0.51% |
  | >= 512 | 6062 | 0.02% |
  | all | 10000 | 4.59% |

  Altering means a 32+ high-entropy run is replaced by `xxxx**********xxxx` (display corruption, never a leak).
- The high-entropy heuristic (upper + lower + digit, >= 6 class switches, not hex/UUID/single-case/identifier+number)
  can miss keys that happen to look low-entropy and can flag non-secrets; scan-bundle false positives go into
  `scripts/scan-bundle-allowlist.json` (sha256 + justification only).
