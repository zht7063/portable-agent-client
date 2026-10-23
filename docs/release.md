# Packaging & release (M6) — local only

> **Nothing is released.** No GitHub release, no uploaded installers, no publish step. All artifacts below are local
> files under `apps/desktop/release/` (git-ignored). Product name, logo and app ID are still **placeholders**
> (`packages/core/src/product.config.json`); branding is a separate, undecided step.

## Build types

| Build | Command (in `apps/desktop`) | Smoke hooks |
|---|---|---|
| dev / test | `bun run build` → `node scripts/build-main.mjs` | compiled in, active only with `PA_SMOKE=1` (`bun run smoke`) |
| production | `bun run build:prod` → `node scripts/build-main.mjs --prod` | **none**: `__PA_SMOKE__=false` folds every smoke branch away and esbuild drops `smoke-*.ts`; the build fails if `PA_SMOKE`/smoke markers survive in main/preload/key-helper |

`build-main.mjs` also embeds the source commit (`git rev-parse HEAD`, `-dirty` if the tree has changes) as the
*build commit* shown in Help → About & licenses.

## Local packaging

```bash
bun install --frozen-lockfile
cd apps/desktop
bun run pack:dir     # prod build + stage + electron-builder --dir         -> release/linux-unpacked/
bun run pack:linux   # prod build + stage + electron-builder AppImage + deb -> release/*-LOCAL.AppImage, *-LOCAL.deb
```

`electron-builder.config.cjs`: `publish: null`, every script passes `--publish never`; Electron is taken from the
local install (`electronDist`). electron-builder downloads its AppImage/fpm tool binaries on first use (download
only). macOS/Windows targets exist as `dir` only and are untested here.

What the package contains:
- `resources/app.asar`: production main/preload/key-helper bundles, the patched new-api web build, and
  `LICENSE`, `NOTICE`, `THIRD-PARTY-LICENSES.md`.
- `resources/licenses/` (plain files): `LICENSE.txt`, `NOTICE.txt`, `THIRD-PARTY-LICENSES.txt`,
  `LICENSE.new-api.txt`, `NOTICE.new-api.txt`, the SIL OFL-1.1 texts of the bundled Lora / Public Sans fonts and
  the Unlicense texts of isbot / text-encoding. The same files are served in-app for the About & licenses page.
- App root: `LICENSE.electron.txt`, `LICENSES.chromium.html` (added by electron-builder).
- Never: `@napi-rs/keyring-linux-*` (bundles libdbus, AFL-2.1 OR GPL-2.0+). Linux uses `secret-tool` or env mode.

## Verification

```bash
cd apps/desktop
PA_SMOKE_NO_SANDBOX=1 xvfb-run -a bash scripts/smoke-linux-artifacts.sh
```

For `linux-unpacked`, the extracted AppImage (`--appimage-extract`, no FUSE) and the extracted `.deb`
(`dpkg-deb -x`, not installed), `scripts/smoke-packaged.mjs` launches the app with a temp HOME and checks:
the renderer loads (`[pac] renderer loaded`), the pa-key wrapper is installed and runs, no smoke markers in any
packaged JS, all license files present (asar + `resources/licenses/`), no keyring-linux binaries.
`apps/desktop/test/packaging.test.ts` checks the config, the license wiring and that the prod bundle has no smoke code.

## AGPL-3.0 obligations (§5, §6, §13)

- **Notices in the app**: Help → *About & licenses* (route `/pa-about`, also linked from the pre-login server
  settings page) shows the AGPL-3.0 notice and no-warranty statement, "*<product>* is based on new-api by QuantumNous
  (AGPL-3.0)", the upstream §7(b) attribution verbatim ("Frontend design and development by New API contributors."
  + link to https://github.com/QuantumNous/new-api), the pinned upstream tag/commit, the source offer and the build
  commit, and every bundled license text.
- **Modified version**: patches are listed with reasons/dates in `patches/new-api-web/README.md`; each patched file
  carries a "Modified by portable-agent-client" note.
- **Source location / offer**: `sourceUrl` and `sourceOffer` in `packages/core/src/product.config.json`
  (placeholder: this repository, which is currently private — see open question below).

## Corresponding Source

A build's Corresponding Source is exactly the git tree of its build commit (pristine upstream snapshot in
`vendor/new-api-web` pinned by `vendor/new-api-web/UPSTREAM` + `compat.json`, the patch queue, our code, both
lockfiles, the build scripts). To produce it:

```bash
scripts/source-tarball.sh <build-commit>   # default HEAD
# -> apps/desktop/release/<exe>-<version>-<commit12>-source.tar.gz (+ .sha256), with SOURCE-INFO.txt
```

Rules for any future distribution (not done yet):
1. Build only from a clean, tagged commit (About must not show `-dirty`); tag it (e.g. `v<version>`).
2. Keep that commit reachable at `sourceUrl`, or ship/offer the matching source tarball alongside the binary.
3. Network use (§13) is not applicable to the client itself, but the About page offers source to every user anyway.

## Not done (needs decisions)

Branding (name, logo/icon, app ID), code signing/notarization, macOS/Windows packaging on real hosts, any publishing.
