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
- **Inline base64 images**: only a word-boundary `data:image/<subtype>;base64,` span whose payload is valid base64
  (alphabet `A-Za-z0-9+/`, <= 2 `=` of padding, length % 4 == 0, >= 64 chars) gets base64 treatment, and only the
  payload span: inside it a 32+ high-entropy run is still masked unless it is bounded by `+` `/` `=` (i.e. looks like
  ordinary base64 data). A key placed in such a payload between base64 separators, or glued to base64 characters, is
  therefore not masked. Every other `data:` form (`data:,K`, `data:x,K`, `data:;base64,K`, `metadata:,K`, short or
  invalid payloads) is ordinary text and masked normally. Outside image spans a run preceded by `+`/`/` or followed by
  `+`/`/`/`=` is treated as part of a base64 run and not masked (a preceding `=`/`==`, e.g. `key=K`, `abc==K`, is masked).
- The high-entropy heuristic (upper + lower + digit, >= 6 class switches, not hex/UUID/single-case/identifier+number)
  can miss keys that happen to look low-entropy and can flag non-secrets; scan-bundle false positives go into
  `scripts/scan-bundle-allowlist.json` (sha256 + justification only).
