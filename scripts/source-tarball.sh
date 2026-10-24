#!/usr/bin/env bash
# M6 / AGPL-3.0 §6: produce the Corresponding Source for a build.
#   scripts/source-tarball.sh [<commit-ish>]   (default HEAD)  -> apps/desktop/release/<exe>-<version>-<commit>-source.tar.gz
# The tree at <commit> is complete source: pristine upstream web snapshot (vendor/new-api-web, pinned in
# vendor/new-api-web/UPSTREAM + compat.json), the patch queue (patches/new-api-web), our own code, lockfiles
# (bun.lock, vendor/new-api-web/bun.lock) and the build scripts. A build's commit is shown in
# Help -> About & licenses ("Build commit", from scripts/build-main.mjs); pass that commit here.
# A build from a dirty tree ("-dirty") has no exact Corresponding Source: only distribute builds from clean commits.
# Local file only: this script never uploads anything.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
REF="${1:-HEAD}"
COMMIT="$(git rev-parse --verify "$REF^{commit}")"
SHORT="${COMMIT:0:12}"
EXE="$(node -p "require('./packages/core/src/product.config.json').executableName")"
VER="$(git show "$COMMIT:apps/desktop/package.json" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const v=JSON.parse(s).version;console.log(v==='0.0.0'?'0.0.1':v)})")"
OUT="$ROOT/apps/desktop/release"
mkdir -p "$OUT"
NAME="$EXE-$VER-$SHORT-source"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
{
  echo "Corresponding Source for $EXE $VER"
  echo "commit: $COMMIT"
  echo "upstream: $(git show "$COMMIT:compat.json" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const c=JSON.parse(s);console.log(c.upstream+' '+c.tag+' '+c.commit)})")"
  echo "license: AGPL-3.0-only (see LICENSE, NOTICE)"
  echo "build: see docs/release.md (bun install --frozen-lockfile; bun run install:web; cd apps/desktop; official: bun run pack:linux | pack:win | pack:mac (refuse while sourceUrl/sourceOffer are placeholders); LOCAL: bun run pack:dir | pack:linux:local | pack:win:local | pack:mac:local)"
} > "$TMP/SOURCE-INFO.txt"
# Reproducible (Aegis M6 item 4): same commit -> byte-identical tarball. Fixed mtime (commit time),
# numeric owner/group 0, sorted entries, no gzip name/timestamp, fixed umask-independent modes.
EPOCH="$(git show -s --format=%ct "$COMMIT")"
mkdir -p "$TMP/stage"
git archive --format=tar --prefix="$NAME/" "$COMMIT" | tar -xf - -C "$TMP/stage"
cp "$TMP/SOURCE-INFO.txt" "$TMP/stage/$NAME/SOURCE-INFO.txt"
chmod -R u+rwX,go+rX,go-w "$TMP/stage"
LC_ALL=C tar --sort=name --mtime="@$EPOCH" --owner=0 --group=0 --numeric-owner \
  --pax-option=exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime \
  --format=posix -C "$TMP/stage" -cf - "$NAME" | gzip -n -9 > "$OUT/$NAME.tar.gz"
sha256sum "$OUT/$NAME.tar.gz" | sed "s,$OUT/,," > "$OUT/$NAME.tar.gz.sha256"
echo "wrote $OUT/$NAME.tar.gz"
