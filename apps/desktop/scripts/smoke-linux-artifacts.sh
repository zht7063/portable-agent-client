#!/usr/bin/env bash
# M6: run the packaged smoke against every local Linux artifact: release/linux-unpacked, the AppImage (extracted, no
# FUSE needed) and the .deb (dpkg-deb -x, not installed). Needs a display (e.g. xvfb-run -a). Local only.
set -euo pipefail
APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REL="$APP/release"
EXE="$(node -p "require('$APP/../../packages/core/src/product.config.json').executableName")"
PRODUCT="$(node -p "require('$APP/../../packages/core/src/product.config.json').productName")"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
rc=0
echo "== linux-unpacked"; node "$APP/scripts/smoke-packaged.mjs" "$REL/linux-unpacked" || rc=1
for ai in "$REL"/*.AppImage; do
  [ -e "$ai" ] || continue
  echo "== $(basename "$ai")"
  (cd "$TMP" && "$ai" --appimage-extract >/dev/null)
  node "$APP/scripts/smoke-packaged.mjs" "$TMP/squashfs-root" || rc=1
done
for deb in "$REL"/*.deb; do
  [ -e "$deb" ] || continue
  echo "== $(basename "$deb")"
  dpkg-deb -x "$deb" "$TMP/deb"
  node "$APP/scripts/smoke-packaged.mjs" "$TMP/deb/opt/$PRODUCT" || rc=1
  dpkg-deb -f "$deb" Package Version Maintainer Homepage
done
exit $rc
