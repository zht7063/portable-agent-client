#!/usr/bin/env bash
# Build the vendored new-api web frontend for the desktop client (plan v2 §1, M2).
#   vendor/new-api-web (pristine, never edited) -> .build/new-api-web (temp copy)
#   -> apply patches/new-api-web/*.patch in order (git-format patches, `git apply`)
#   -> bun install --frozen-lockfile -> rsbuild build -> apps/desktop/dist/renderer
# Usage: scripts/build-new-api-web.sh [--no-install]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/vendor/new-api-web"
BUILD="$ROOT/.build/new-api-web"
OUT="$ROOT/apps/desktop/dist/renderer"
PATCHES="$ROOT/patches/new-api-web"

command -v bun >/dev/null || { echo "bun is required" >&2; exit 1; }
[ -f "$SRC/UPSTREAM" ] || { echo "missing $SRC/UPSTREAM" >&2; exit 1; }

# Keep node_modules between builds (speed), replace everything else from the pristine vendor copy.
mkdir -p "$BUILD"
find "$BUILD" -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
(cd "$SRC" && tar -cf - .) | (cd "$BUILD" && tar -xf -)

shopt -s nullglob
for p in "$PATCHES"/*.patch; do
  echo "applying $(basename "$p")"
  # Run from ROOT with --directory: inside our work tree, a plain `git apply` in $BUILD would silently skip paths.
  (cd "$ROOT" && git apply -p1 --whitespace=nowarn --directory=.build/new-api-web "$p")
  # Fail loudly if the patch did not actually land (it must now reverse-apply cleanly).
  (cd "$ROOT" && git apply -p1 -R --check --directory=.build/new-api-web "$p") || { echo "patch $(basename "$p") did not apply" >&2; exit 1; }
done

cd "$BUILD"
if [ "${1:-}" != "--no-install" ]; then bun install --frozen-lockfile; fi
NODE_ENV=production bunx --bun rsbuild build
rm -rf "$OUT"
mkdir -p "$OUT"
cp -R dist/. "$OUT/"
# Ship upstream license notices next to the bundle.
cp "$SRC/LICENSE" "$OUT/LICENSE.new-api.txt"
cp "$SRC/NOTICE.upstream" "$OUT/NOTICE.new-api.txt"
# Non-allowlisted (OFL-1.1 / Unlicense) bundled packages: ship their license texts with the bundle.
mkdir -p "$OUT/licenses"
for pkg in @fontsource-variable/lora @fontsource-variable/public-sans isbot text-encoding; do
  lic=$(ls "node_modules/$pkg" 2>/dev/null | grep -iE '^(LICEN[CS]E|COPYING)(\.(md|txt))?$' | head -1 || true)
  [ -n "$lic" ] || { echo "missing license file for $pkg" >&2; exit 1; }
  cp "node_modules/$pkg/$lic" "$OUT/licenses/$(echo "$pkg" | tr '/@' '__' | sed 's/^_//').LICENSE.txt"
done
echo "built new-api web -> $OUT"
