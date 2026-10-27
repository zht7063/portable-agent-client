#!/usr/bin/env bash
# Run CI's refusal cases in an isolated clean replica, including uncommitted guard fixes.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
git clone --quiet --no-hardlinks --local "$ROOT" "$T/repo"
mkdir -p "$T/repo/apps/desktop/build"
cp "$ROOT/apps/desktop/scripts/check-placeholders.cjs" "$T/repo/apps/desktop/scripts/"
cp "$ROOT/apps/desktop/build/server-origin.json" "$T/repo/apps/desktop/build/"
cp "$ROOT/packages/core/src/product.config.json" "$T/product.json"
cd "$T/repo"
# The replica uses the current guard/config without creating commits or altering the caller's index.
git update-index --assume-unchanged apps/desktop/scripts/check-placeholders.cjs apps/desktop/build/server-origin.json packages/core/src/product.config.json
refuse() {
  local want="$1"; shift
  if "$@" >"$T/out" 2>"$T/err"; then echo "guard unexpectedly passed"; exit 1; fi
  grep -Fq "$want" "$T/err" || { cat "$T/err"; exit 1; }
  echo "PASS: $want"
}
node -e 'const fs=require("fs");let p=JSON.parse(fs.readFileSync(process.argv[1]));p.$placeholders=["sourceUrl","sourceOffer"];fs.writeFileSync(process.argv[2],JSON.stringify(p))' "$T/product.json" packages/core/src/product.config.json
cd apps/desktop
PA_LOCAL_BUILD=1 refuse 'unreplaced placeholder' node scripts/check-placeholders.cjs --official
cp "$T/product.json" ../../packages/core/src/product.config.json
PA_BUILD_COMMIT=0000000000000000000000000000000000000000 refuse 'does not match git HEAD' node scripts/check-placeholders.cjs --official
touch ci-dirty-marker.txt
refuse 'working tree is dirty' node scripts/check-placeholders.cjs --official
rm ci-dirty-marker.txt
printf '%s\n' '{"origin":"https://release-placeholder.invalid"}' > build/server-origin.json
refuse 'D-17 production HTTPS origin is still a placeholder' node scripts/check-placeholders.cjs --official
printf '%s\n' '{"origin":"https://release-placeholder.invalid."}' > build/server-origin.json
refuse 'D-17 production HTTPS origin is still a placeholder' node scripts/check-placeholders.cjs --official
printf '%s\n' '{"origin":"http://flowpier.top:3000/v1"}' > build/server-origin.json
refuse 'expected a bare http(s) origin' node scripts/check-placeholders.cjs --official
printf '%s\n' '{"origin":"http://user:pw@flowpier.top:3000"}' > build/server-origin.json
refuse 'expected a bare http(s) origin' node scripts/check-placeholders.cjs --official
printf '%s\n' '{"origin":"http://127.0.0.1:3000"}' > build/server-origin.json
refuse 'loopback origin is not allowed' node scripts/check-placeholders.cjs --official
rm build/server-origin.json
refuse 'cannot use build/server-origin.json' node scripts/check-placeholders.cjs --official
