/* portable-agent-client local route (AGPL-3.0-only); copied into the new-api web build by scripts/build-new-api-web.sh. */
import { createFileRoute } from '@tanstack/react-router'

import { AboutPage } from '@/pa-local/about/about-page'

export const Route = createFileRoute('/(auth)/pa-about')({
  component: AboutPage,
})
