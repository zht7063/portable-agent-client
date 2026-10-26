/*
 * portable-agent-client local pages (AGPL-3.0-only).
 * Harness configuration page: one card per harness. Token list / models come from the standard API through the
 * main-process proxy (masked keys only); writes go through pa.harness.* (main).
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { SectionPageLayout } from '@/components/layout'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Label } from '@/components/ui/label'
import type { HarnessProfile } from '../lib/pa-types'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { getApiKeys } from '@/features/keys/api'
import { getUserModels } from '@/lib/api'

import { errText, HARNESS_IDS, pa, unwrap } from '../lib/pa'
import { HarnessCard, type TokenOption } from './harness-card'

export function HarnessPage() {
  const { t } = useTranslation()
  const [serverUrl, setServerUrl] = useState<string | null>(null)
  const [tokens, setTokens] = useState<TokenOption[]>([])
  const [tokenId, setTokenId] = useState<number | null>(null)
  const [models, setModels] = useState<string[]>([])
  const [providers, setProviders] = useState<HarnessProfile[]>([])
  const [label, setLabel] = useState('Swift provider')
  const [busy, setBusy] = useState(false)
  const [removeId, setRemoveId] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const c = await unwrap(pa().config.get())
        if (live) setServerUrl(c.serverUrl)
        const saved = await unwrap(pa().harness.providers())
        if (live) setProviders(saved.profiles)
        const [k, m] = await Promise.all([getApiKeys({ p: 1, size: 100 }), getUserModels()])
        if (!live) return
        // `key` here is already masked by the main-process proxy.
        setTokens((k.data?.items ?? []).map((x) => ({ id: x.id, name: x.name, maskedKey: x.key.startsWith('sk-') ? x.key : `sk-${x.key}` })))
        setModels(m.data ?? [])
      } catch (e) { if (live) setErr(errText(e)) }
    })()
    return () => { live = false }
  }, [revision])

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>{t('Harness')}</SectionPageLayout.Title>
      <SectionPageLayout.Content>
        <div className='space-y-4'>
          <p className='text-muted-foreground text-sm'>
            {t('Point local coding agents at this server. Keys are stored as private plaintext files. Claude commands, hooks and MCP children inherit the token. Exclude configs from cloud sync and dotfiles; set a server quota limit.')}
          </p>
          {err && <Alert variant='destructive'><AlertDescription>{err}</AlertDescription></Alert>}
          <div className='space-y-3 rounded-md border p-4' aria-label={t('Providers')}>
            <Label htmlFor='provider-label'>{t('Provider name')}</Label>
            <Input id='provider-label' value={label} onChange={(e) => setLabel(e.target.value)} />
            <Label htmlFor='provider-token'>{t('API key')}</Label>
            <NativeSelect id='provider-token' value={tokenId ?? ''} onChange={(e) => setTokenId(e.target.value ? Number(e.target.value) : null)}>
              <NativeSelectOption value=''>{t('Select an API key')}</NativeSelectOption>
              {tokens.map((token) => <NativeSelectOption key={token.id} value={token.id}>{token.name} ({token.maskedKey})</NativeSelectOption>)}
            </NativeSelect>
            <Button disabled={busy || tokenId === null || !label.trim()} onClick={() => { setBusy(true); setErr(null); void unwrap(pa().harness.saveProvider({ label: label.trim(), keyId: tokenId ?? 0, models: { main: 'claude-main-placeholder', small: 'claude-small-placeholder' } })).then(() => setRevision((v) => v + 1)).catch((e) => setErr(errText(e))).finally(() => setBusy(false)) }}>{t('Add provider')}</Button>
            {providers.map((p) => <div key={p.id} className='flex flex-wrap items-center gap-2 text-sm'>
              <span>{p.label ?? p.id} · {t('Key')}: *** · #{p.keyId}</span>
              <Button variant='outline' disabled={busy} onClick={() => { setBusy(true); void unwrap(pa().harness.activateProvider({ profileId: p.id })).then(() => setRevision((v) => v + 1)).catch((e) => setErr(errText(e))).finally(() => setBusy(false)) }}>{t('Select for preview')}</Button>
              <Button variant='outline' disabled={busy} onClick={() => setRemoveId(p.id)}>{t('Delete provider')}</Button>
            </div>)}
          </div>
          <ConfirmDialog open={!!removeId} onOpenChange={(v) => { if (!v) setRemoveId(null) }} title={t('Delete provider')} desc={t('Remove this provider, its managed configuration and local key? Revoke the token on the server separately.')} confirmText={t('Delete provider')} disabled={busy} handleConfirm={() => { const id = removeId; setRemoveId(null); if (!id) return; setBusy(true); void unwrap(pa().harness.deleteProvider({ profileId: id, confirm: true })).then(() => setRevision((v) => v + 1)).catch((e) => setErr(errText(e))).finally(() => setBusy(false)) }} />
          {HARNESS_IDS.filter((h) => h !== 'pi').map((h) => <HarnessCard key={`${h}-${revision}`} harness={h} serverUrl={serverUrl} tokens={tokens} models={models} />)}
        </div>
      </SectionPageLayout.Content>
    </SectionPageLayout>
  )
}
