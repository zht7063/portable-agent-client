#!/usr/bin/env bash
# M5: typecheck + lint + vitest for src-local pages and patched upstream files inside a prepared new-api web tree.
# Any failure is real (no blanket swallowing): typecheck covers the whole tree and only tolerates pre-existing upstream
# errors in files listed in scripts/local-pages-tsc-baseline.txt; oxlint runs on our pages + patched files only
# (upstream has pre-existing lint findings elsewhere, e.g. inline type imports in keys/data-table-bulk-actions.tsx,
# which patch 0003 touches but which are not linted here); vitest runs our tests.
# Offline: run with --no-install after `bun run install:web` (the only step that needs network; see docs/release.md).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
for a in "$@"; do
  if [ "$a" = --no-install ] && [ ! -d "$ROOT/.build/new-api-web/node_modules" ]; then
    echo "vendored web dependencies not installed; run: bun run install:web" >&2; exit 1
  fi
done
"$ROOT/scripts/build-new-api-web.sh" --prepare-only "$@"
cd "$ROOT/.build/new-api-web"
BASELINE="$ROOT/scripts/local-pages-tsc-baseline.txt"
# Typecheck the whole prepared tree. tsgo exits non-zero on any error; we only tolerate errors located in the
# explicitly listed pre-existing upstream files (baseline). Anything else -- including any error in our pages or
# patched files, or a tsgo crash without diagnostics -- fails.
set +e
tc=$(bunx tsgo -b 2>&1); tc_rc=$?
set -e
if [ "$tc_rc" -ne 0 ]; then
  files=$(printf '%s\n' "$tc" | grep -oE '^[^ (]+\.(ts|tsx)\([0-9]+,[0-9]+\): error' | sed -E 's/\(.*//' | sort -u)
  [ -n "$files" ] || { printf '%s\n' "$tc" >&2; echo "typecheck failed (no diagnostics parsed)" >&2; exit 1; }
  allowed=$(grep -vE '^\s*(#|$)' "$BASELINE")
  unexpected=$(awk 'NR==FNR { ok[$0]=1; next } !($0 in ok)' <(printf '%s\n' "$allowed") <(printf '%s\n' "$files"))
  if [ -n "$unexpected" ]; then
    printf '%s\n' "$tc" | grep -F -f <(printf '%s\n' "$unexpected") >&2
    echo "typecheck failed outside the upstream baseline: $(echo $unexpected)" >&2; exit 1
  fi
  echo "typecheck: only baseline upstream findings ($(echo $files))"
else
  echo "typecheck: clean"
fi
bunx oxlint -c .oxlintrc.json src/pa-local src/routes/_authenticated/pa "src/routes/(auth)/pa-server.tsx" "src/routes/(auth)/pa-about.tsx" src/hooks/use-sidebar-data.ts \
  src/features/keys/components/api-keys-cells.tsx src/features/keys/components/data-table-row-actions.tsx \
  src/features/auth/sign-in/index.tsx src/features/dashboard/components/overview/overview-dashboard.tsx
bunx vitest run src/pa-local src/hooks/__tests__/sidebar-config.test.tsx
