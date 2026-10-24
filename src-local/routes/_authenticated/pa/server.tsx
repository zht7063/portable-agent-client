/* portable-agent-client local route (AGPL-3.0-only); copied into the new-api web build by scripts/build-new-api-web.sh. */
import { createFileRoute } from '@tanstack/react-router'

import { ServerPage } from '@/pa-local/server/server-settings'

export const Route = createFileRoute('/_authenticated/pa/server')({
  component: ServerPage,
})
