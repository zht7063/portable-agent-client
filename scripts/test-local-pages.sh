#!/usr/bin/env bash
# M5: typecheck + lint + vitest for src-local pages and patched upstream files inside a prepared new-api web tree.
# Upstream has pre-existing tsc/oxlint findings in files we do not touch; only findings in our files fail this script.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
"$ROOT/scripts/build-new-api-web.sh" --prepare-only "$@"
cd "$ROOT/.build/new-api-web"
OURS='src/pa-local/|src/features/auth/sign-in/index|src/features/dashboard/components/overview/overview-dashboard|src/routes/_authenticated/pa/|src/routes/\(auth\)/pa-server|src/hooks/use-sidebar-data|src/features/keys/components/(api-keys-cells|data-table-row-actions)'
tc=$(bunx tsgo -b 2>&1 || true)
if echo "$tc" | grep -E "error" | grep -E "$OURS"; then echo "typecheck failed in local/patched files" >&2; exit 1; fi
echo "typecheck: no findings in local/patched files"
bunx oxlint -c .oxlintrc.json src/pa-local src/routes/_authenticated/pa "src/routes/(auth)/pa-server.tsx" src/hooks/use-sidebar-data.ts \
  src/features/keys/components/api-keys-cells.tsx src/features/keys/components/data-table-row-actions.tsx \
  src/features/auth/sign-in/index.tsx src/features/dashboard/components/overview/overview-dashboard.tsx
bunx vitest run src/pa-local src/hooks/__tests__/sidebar-config.test.tsx
