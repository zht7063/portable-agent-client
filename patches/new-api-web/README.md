# Patch queue for vendored new-api web

`vendor/new-api-web/` is a **pristine** snapshot of QuantumNous/new-api `web/` (tag/commit in
`vendor/new-api-web/UPSTREAM`, mirrored in `compat.json`). It is never edited by hand.

Local modifications live here as `git format-patch` files, applied **in filename order** at build time by
`scripts/build-new-api-web.sh` to a throwaway copy in `.build/new-api-web/` (git-ignored). Patch paths are
relative to the upstream `web/` directory (`git apply -p1`).

## Modification notice (AGPL-3.0 §5(a), §7(c))

The bundled frontend is a **modified version** of new-api's web frontend. Every patch below is a change made by
the portable-agent-client contributors; each touched file additionally carries a "Modified by
portable-agent-client" note where the file format allows comments. The upstream attribution required under §7(b)
("Frontend design and development by New API contributors." + link to https://github.com/QuantumNous/new-api) is
preserved (upstream UI footer/about untouched; also in our NOTICE).

| Patch | Files | Why | Date |
|---|---|---|---|
| `0001-csp-move-inline-theme-script.patch` | `index.html`, new `public/theme-init.js` | The desktop renderer runs under a strict CSP (`script-src 'self'`, no inline scripts). Upstream's pre-paint theme script was inline in `index.html`; it is moved verbatim into a same-origin file. No behaviour change. | 2026-10-24 (M2) |

No base-path or router-mode patch is needed: the app is served from the root of a standard, secure custom
origin (`<scheme>://app/`), so upstream's absolute `/static/...` asset URLs and browser-history routing work as-is
(main serves `index.html` for extension-less routes).

## Adding / updating a patch

```bash
rm -rf /tmp/pw && cp -r vendor/new-api-web /tmp/pw && cd /tmp/pw && git init -q && git add -A && git commit -qm base
for p in "$OLDPWD"/patches/new-api-web/*.patch; do git am -q "$p"; done   # replay existing queue
# ... edit, add a "Modified by portable-agent-client (patch NNNN)" note, commit ...
git format-patch -1 -o "$OLDPWD/patches/new-api-web" --start-number NNNN
```

Then add a row to the table above. Keep patches small and focused (plan v2 §6).
