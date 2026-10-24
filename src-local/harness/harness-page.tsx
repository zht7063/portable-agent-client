/*
 * portable-agent-client local pages (AGPL-3.0-only).
 * Harness configuration page: one card per harness. Token list / models come from the standard API through the
 * main-process proxy (masked keys only); writes go through pa.harness.* (main).
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { SectionPageLayout } from '@/components/layout'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { getApiKeys } from '@/features/keys/api'
import { getUserModels } from '@/lib/api'

import { errText, HARNESS_IDS, pa, unwrap } from '../lib/pa'
import { HarnessCard, type TokenOption } from './harness-card'

export function HarnessPage() {
  const { t } = useTranslation()
  const [serverUrl, setServerUrl] = useState<string | null>(null)
  const [tokens, setTokens] = useState<TokenOption[]>([])
  const [models, setModels] = useState<string[]>([])
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const c = await unwrap(pa().config.get())
        if (live) setServerUrl(c.serverUrl)
        const [k, m] = await Promise.all([getApiKeys({ p: 1, size: 100 }), getUserModels()])
        if (!live) return
        // `key` here is already masked by the main-process proxy.
        setTokens((k.data?.items ?? []).map((x) => ({ id: x.id, name: x.name, maskedKey: x.key.startsWith('sk-') ? x.key : `sk-${x.key}` })))
        setModels(m.data ?? [])
      } catch (e) { if (live) setErr(errText(e)) }
    })()
    return () => { live = false }
  }, [])

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>{t('Harness')}</SectionPageLayout.Title>
      <SectionPageLayout.Content>
        <div className='space-y-4'>
          <p className='text-muted-foreground text-sm'>
            {t('Point local coding agents at this server. Keys stay in the system keychain; previews show masked values only.')}
          </p>
          {err && <Alert variant='destructive'><AlertDescription>{err}</AlertDescription></Alert>}
          {HARNESS_IDS.map((h) => <HarnessCard key={h} harness={h} serverUrl={serverUrl} tokens={tokens} models={models} />)}
        </div>
      </SectionPageLayout.Content>
    </SectionPageLayout>
  )
}
