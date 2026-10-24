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
| `0002-new-api-web-desktop-nav-group-for-local-pages.patch` | `src/hooks/use-sidebar-data.ts` | Adds a "Desktop" sidebar group (Harness / Keychain / Server settings) linking to our local pages, only when the desktop preload bridge is present (`isPaDesktop()`); the plain web build is unchanged. | 2026-10-24 (M5) |
| `0003-new-api-web-route-API-key-copy-show-store-through-th.patch` | `src/features/keys/components/{api-keys-cells,data-table-row-actions,data-table-bulk-actions}.tsx` | In the desktop client the proxy masks every key the renderer sees, so upstream's copy icon / Copy Key / Copy Connection Info / CC Switch / chat presets / batch copy would silently use a masked value. In the desktop they are replaced by `pa-local` actions (Copy key and Show key run in main; Store to keychain), and batch copy is hidden. The web build is unchanged. | 2026-10-24 (M5) |
| `0004-new-api-web-desktop-only-server-settings-link-on-sig.patch` | `src/features/auth/sign-in/index.tsx` | Adds a "Server settings" link under the sign-in form pointing to our public `/pa-server` page, so a user can change/check the server before signing in. Desktop only (`isPaDesktop()`); web build unchanged. | 2026-10-24 (M5) |
| `0005-new-api-web-dashboard-copy-curl-through-the-desktop-.patch` | `src/features/dashboard/components/overview/overview-dashboard.tsx` | Dashboard overview "Copy" (ready-to-run curl) fetched the real key in the renderer; in the desktop the renderer only sees masked keys, so it now calls `pa.keys.copy({ tokenId, curl: { endpoint, model } })`: main fetches the key, builds the curl (endpoint/model validated) and writes the clipboard with the usual auto-clear. Web build unchanged. | 2026-10-24 (M5) |
| `0006-new-api-web-desktop-only-hide-chat-presets-and-chat-routes.patch` | `src/hooks/use-sidebar-data.ts`, `src/components/layout/components/nav-group.tsx`, `src/routes/_authenticated/{chat/$chatId,chat2link}.tsx`, `src/features/chat/lib/chat-links.ts`, `src/features/chat/hooks/use-active-chat-key.ts` | Chat presets substitute the API key into a URL (`{key}`, iframe / external link / FluentRead). In the desktop the renderer only holds masked keys, so these would produce broken links containing a masked key. Desktop only (`isPaDesktop()`): the sidebar Chat presets entry is hidden, `/chat/$chatId` and `/chat2link` redirect to `/dashboard`, and as defence in depth `resolveChatUrl` returns `''` and `fetchActiveChatKey` throws. Playground is unaffected (no key in links). Web build unchanged. | 2026-10-24 (M6) |

M3 (main-process `/api` proxy, login option A) needed **no frontend patch**: upstream keeps the access token in an
in-memory store only and nothing credential-bearing in localStorage; the proxy hands the renderer an opaque handle and
masks keys server-side of the renderer (see `docs/proxy.md`).

No base-path or router-mode patch is needed: the app is served from the root of a standard, secure custom
origin (`<scheme>://app/`), so upstream's absolute `/static/...` asset URLs and browser-history routing work as-is
(main serves `index.html` for extension-less routes).

## Local pages (`src-local/`, not a patch)

Our own pages (harness config, keychain, server settings, desktop key actions) are original AGPL-3.0 code in
`src-local/`. The build copies them to `src/pa-local/`, and copies `src-local/routes/` into `src/routes/` (TanStack
file routes: `/pa/harness`, `/pa/keychain`, `/pa/server`, and the public `/pa-server`) **before** the patch queue runs. Patches 0002–0005 are
the only upstream files that import them.

## Adding / updating a patch

```bash
rm -rf /tmp/pw && cp -r vendor/new-api-web /tmp/pw && cd /tmp/pw && git init -q && git add -A && git commit -qm base
for p in "$OLDPWD"/patches/new-api-web/*.patch; do git am -q "$p"; done   # replay existing queue
# ... edit, add a "Modified by portable-agent-client (patch NNNN)" note, commit ...
git format-patch -1 -o "$OLDPWD/patches/new-api-web" --start-number NNNN
```

Then add a row to the table above. Keep patches small and focused (plan v2 §6).
