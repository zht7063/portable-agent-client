#!/usr/bin/env bash
# Re-vendor new-api web/ at a new upstream tag (plan v2 §6). Local, reversible; does not commit or push.
#   scripts/update-upstream.sh <tag>
# Steps: fetch tag -> replace vendor/new-api-web with pristine `git archive <tag> web` (+ upstream LICENSE/NOTICE)
#        -> write UPSTREAM -> update compat.json tag/commit -> rebuild (replays patches/new-api-web/*.patch; fails
#        loudly if a patch no longer applies) -> run license check. Review `git diff`, then run tests/smoke.
set -euo pipefail
TAG="${1:?usage: update-upstream.sh <tag>}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="https://github.com/QuantumNous/new-api"
TMP="$ROOT/.tmp-upstream"
rm -rf "$TMP"; mkdir -p "$TMP"
git -C "$TMP" init -q
git -C "$TMP" fetch -q --depth 1 "$REPO" "refs/tags/$TAG:refs/tags/$TAG"
COMMIT="$(git -C "$TMP" rev-parse "$TAG^{commit}")"
DEST="$ROOT/vendor/new-api-web"
rm -rf "$DEST"; mkdir -p "$ROOT/vendor"
git -C "$TMP" archive "$TAG" web | tar -x -C "$TMP"
mv "$TMP/web" "$DEST"
git -C "$TMP" show "$TAG:LICENSE" > "$DEST/LICENSE"
git -C "$TMP" show "$TAG:NOTICE" > "$DEST/NOTICE.upstream"
cat > "$DEST/UPSTREAM" <<EOT
repo=$REPO
path=web
tag=$TAG
commit=$COMMIT
license=AGPL-3.0 (LICENSE copied from upstream repo root; upstream NOTICE kept as NOTICE.upstream)
note=Pristine snapshot via \`git archive <tag> web\`. Do not edit; local changes live in patches/new-api-web/.
EOT
node -e '
const fs=require("fs"),p=process.argv[1],j=JSON.parse(fs.readFileSync(p,"utf8"));
j.tag=process.argv[2]; j.commit=process.argv[3]; j.maxServerTested=null;
fs.writeFileSync(p, JSON.stringify(j,null,2)+"\n");' "$ROOT/compat.json" "$TAG" "$COMMIT"
rm -rf "$TMP"
bash "$ROOT/scripts/build-new-api-web.sh"
node "$ROOT/scripts/check-licenses.mjs" --write >/dev/null
echo "vendored new-api web $TAG ($COMMIT). Review git diff, then: bun run check && (cd apps/desktop && bun run smoke)"
