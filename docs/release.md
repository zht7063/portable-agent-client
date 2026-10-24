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
bun run pack:dir          # prod build + stage + electron-builder --dir (LOCAL) -> release/linux-unpacked/
bun run pack:linux:local  # LOCAL AppImage + deb -> release/*-LOCAL.AppImage, *-LOCAL.deb
# Official scripts (pack:linux / pack:win / pack:mac) run `PA_LOCAL_BUILD=0 node scripts/check-placeholders.cjs --official`
# first and REFUSE while the source offer is a placeholder; they set PA_LOCAL_BUILD=0 explicitly (an inherited
# PA_LOCAL_BUILD=1 cannot bypass the guard) and their artifacts carry no -LOCAL suffix.
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
  They stay listed in `"$placeholders"`; `electron-builder.config.cjs` (scripts/check-placeholders.cjs) **refuses to
  package** while either is unreplaced, unless the explicit local flag `PA_LOCAL_BUILD=1` is set. Only `pack:dir` and the
  `pack:*:local` scripts (artifacts named `*-LOCAL`, never distributed) set it; the official `pack:linux`, `pack:win`,
  `pack:mac` never do. The guard passes with either a public https `sourceUrl` (decision a) or a written `sourceOffer`
  (decision b), provided neither is still listed in `$placeholders` and no placeholder text remains (PLACEHOLDER,
  place-holder, TODO, TBD, FIXME, `<...>`, example.invalid). `sourceUrl` must be `https://<host>/<owner>/<repo>` on an
  allowlisted host (github.com, gitlab.com, codeberg.org): no userinfo, IP, port, localhost or .example/.invalid/.test
  hosts, no TODO/TBD path. `sourceOffer` must be at least 120 characters and state a validity period ("valid for at
  least three years …") and a contact (email or https URL). In official mode (`--official`) the guard also needs a
  clean working tree and uses `git rev-parse HEAD` as the build commit (`PA_BUILD_COMMIT`, if set, must equal HEAD; `build-main.mjs --prod` enforces the same and always appends `-dirty` for a dirty tree); the fetch times out after 15 s and anonymously GETs
  `<sourceUrl>/tree/<commit>` (no credentials, no redirects followed) and requires HTTP 200. A release build must
  replace both values, drop them from `"$placeholders"`, and use the official scripts (which force `PA_LOCAL_BUILD=0`).
  `pack:mac` stages and packages arm64 and x64 in two separate runs, so each package's generated `package.json`
  declares only the keychain binary it bundles.

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

## Local installers: Windows (NSIS) and macOS (dmg) — unsigned, LOCAL, never published

Today only the `:local` variants work (named `*-LOCAL.*`, `PA_LOCAL_BUILD=1`); the official `pack:win`/`pack:mac` refuse until the source-offer decision is applied.
Nothing is signed or notarized; nothing is uploaded (`publish: null`, `--publish never`). appId/productName/branding
are still placeholders (see the TODO below).

| Platform | Command (in `apps/desktop`) | Build host | Output in `release/` |
| --- | --- | --- | --- |
| Windows x64 | `bun run pack:win:local` (official: `pack:win`) | Windows (or Linux/macOS **with wine**) | `portable-agent-<ver>-win-x64-LOCAL.exe` (NSIS, + `win-unpacked/`) |
| macOS arm64 + x64 | `bun run pack:mac:local` (official: `pack:mac`) | **macOS only** (dmg needs hdiutil) | `portable-agent-<ver>-mac-arm64-LOCAL.dmg`, `…-mac-x64-LOCAL.dmg` (+ `mac*/`) |
| Linux x64 | `bun run pack:linux:local` (official: `pack:linux`) | Linux | AppImage + deb |

- NSIS installer: assisted (not one-click), per-user by default with optional elevation, install directory can be
  changed, desktop + Start-menu shortcuts, AGPL license page, uninstaller (app data is kept on uninstall).
- Native keychain module: `scripts/stage.mjs` stages `@napi-rs/keyring` + the target's binary and declares them as
  `dependencies` (each per-arch package keeps only its own `keyring-<os>-<arch>` binary via `!(${arch})` excludes) in the staged package.json (electron-builder drops undeclared node_modules). bun installs only the
  host's binary; for a cross-build fetch the target's package first, e.g.
  `npm pack @napi-rs/keyring-win32-x64-msvc@2.1.2` → extract to `<dir>/node_modules/@napi-rs/keyring-win32-x64-msvc/`
  and run with `PA_NATIVE_PREBUILT_DIR=<dir>`. Without it the build warns and the app falls back to env key mode.
- Cross-building Windows on Linux needs wine (rcedit + NSIS uninstaller extraction). Without wine only a portable zip
  works: `PA_LOCAL_BUILD=1 electron-builder --config electron-builder.config.cjs --win zip --x64 --publish never -c.win.signAndEditExecutable=false`
  (after `bun run build:prod` and `PA_TARGET_PLATFORM=win32 PA_TARGET_ARCH=x64 node scripts/stage.mjs`); the exe then
  keeps Electron's default version info.
- For Windows/macOS targets electron-builder downloads the official Electron zip (checksum-verified) into its cache;
  the local Electron is used only for native Linux builds.
- Scan: `node scripts/scan-bundle.mjs` scans `release/` recursively (`win-unpacked/`, `mac*/…app`, app.asar). The
  compressed `.exe`/`.dmg` themselves are not unpacked; scan the unpacked dirs produced by the same run.

### Unsigned caveats
- **Windows SmartScreen**: "Windows protected your PC" → *More info* → *Run anyway*. Some AV may flag unsigned NSIS.
- **macOS Gatekeeper**: "cannot be opened / is damaged" → right-click → *Open*, or System Settings → Privacy &
  Security → *Open Anyway*, or `xattr -dr com.apple.quarantine "/Applications/<App>.app"`. arm64 builds are ad-hoc
  signed by the toolchain; no Developer ID, not notarized.
- Distribution to others needs the AGPL source-offer decision, real branding/appId, and signing (Apple Developer ID +
  notarization; Windows code-signing certificate).

## Official installer build (manual workflow)

`.github/workflows/release-build.yml` (workflow_dispatch only, contents: read, no secrets, no publish/release step)
runs the official `pack:win` (NSIS x64, unsigned) and `pack:mac` (dmg arm64 + x64, ad-hoc signed in afterPack) on
windows-2025 / macos-14. Their `--official` guard runs first and refuses until the source repo is public and reachable
at the build commit. Then: ad-hoc signature verification, scan-bundle, `.sha256` files, artifacts kept 7 days.

## TODO: official production packaging (blocked on a decision)

Also pending: branding/appId (placeholders) and signing for Windows/macOS installers.

**Pending yubai's decision on how the AGPL Corresponding Source is offered**: (a) a public source repository at
`sourceUrl`, or (b) a written offer (`sourceOffer`) with the matching source tarball. Until then there is **no**
production packaging command, and none may be run.

Planned command (will only work once the decision is made):

```bash
# 1. Replace sourceUrl / sourceOffer in packages/core/src/product.config.json and remove both from "$placeholders".
# 2. From a clean, tagged build commit, WITHOUT PA_LOCAL_BUILD:
cd apps/desktop
bun run build:prod && node scripts/stage.mjs \
  && electron-builder --config electron-builder.config.cjs --linux AppImage deb --publish never
# 3. scripts/source-tarball.sh <build-commit>; node scripts/scan-bundle.mjs
```

Manual release sign-off (in addition to the automatic guard):

- [ ] Logged out / in a private window (no GitHub session, no token), open `<sourceUrl>/tree/<build-commit>` and
      confirm it loads (HTTP 200) and shows exactly the commit the artifacts were built from (compare with
      About → build commit and `SOURCE-INFO`).
- [ ] The tarball from `scripts/source-tarball.sh <build-commit>` matches that commit.
- [ ] If a written offer is used: read the final `sourceOffer` text as shown in About — correct legal entity, a
      working contact (email/URL), a validity period of at least three years, and how the source is delivered.
- [ ] The release tag exists on the public repository and points at the build commit
      (`git ls-remote --tags <sourceUrl> <tag>` run anonymously shows `<build-commit>`).

While the placeholder source links are unreplaced, `scripts/check-placeholders.cjs` makes this command fail by design.
Still open alongside it: branding, signing/notarization, macOS/Windows hosts, publishing (see below).

## Not done (needs decisions)

Branding (name, logo/icon, app ID), code signing/notarization, macOS/Windows packaging on real hosts, any publishing.

## CI: vendored web page checks

`bun run test` = root vitest + `scripts/test-local-pages.sh --no-install` (offline; typecheck of the whole prepared
new-api web tree with only `scripts/local-pages-tsc-baseline.txt` upstream files tolerated, oxlint on our pages/patched
files, vitest for `src/pa-local`). Its dependencies need network once, as a separate CI step before `bun run test`:

    bun run install:web   # = build-new-api-web.sh --prepare-only (bun install --frozen-lockfile in .build/new-api-web)

Without it the local-pages part is skipped with "local-pages: SKIPPED: vendored web dependencies not installed" and
`bun run test` still passes on the root vitest suite. CI must set `PA_REQUIRE_WEB_DEPS=1`, which turns a missing
install into a failure ("local-pages: FAIL"), so CI can never silently skip these checks:

    bun run install:web && PA_REQUIRE_WEB_DEPS=1 bun run test
