/* portable-agent-client local route (AGPL-3.0-only); copied into the new-api web build by scripts/build-new-api-web.sh. */
import { createFileRoute } from '@tanstack/react-router'

import { KeychainPage } from '@/pa-local/keychain/keychain-section'

export const Route = createFileRoute('/_authenticated/pa/keychain')({
  component: KeychainPage,
})
