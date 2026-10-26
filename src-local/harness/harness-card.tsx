/*
 * portable-agent-client local pages (AGPL-3.0-only).
 * Harness card (Pi / Claude Code / Codex). Logic ported from portable-agent feat/client HarnessPanel @ f2049d8,
 * rebuilt on the upstream component library. Only masked values reach this component; keys stay in main.
 */
import { Loader2, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'

import { errText, fileName, HARNESS_TITLE, pa, unwrap } from '../lib/pa'
import type {
  ConflictResolution, Detection, HarnessChannelStatus, HarnessHistory, HarnessId, ProviderInput, HarnessTestResult, KeyringStatus,
  Plan, RollbackPreview, RollbackTarget,
} from '../lib/pa-types'
import { DiffTable } from './diff-table'

export interface TokenOption { id: number; name: string; maskedKey: string }

const PROFILE = 'default'
const META: Record<HarnessId, { bin: string; small: string | null }> = {
  pi: { bin: 'pi', small: 'Fallback model' },
  claude: { bin: 'claude', small: 'Haiku (background) model' },
  codex: { bin: 'codex', small: null },
}
const CHANNEL: Record<HarnessChannelStatus['state'], string> = {
  'not-checked': 'Server channel not checked',
  'no-profile': 'Server channel unknown (preview once to save the profile)',
  unreachable: 'Server channel unreachable',
  'model-missing': 'Model not listed in /v1/models',
  'model-listed': 'Model listed (Responses channel not live-verified)',
}
const ACTION: Record<string, string> = { apply: 'before apply', rollback: 'before rollback', detach: 'before detach' }
const when = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleString() }

type Pending =
  | { kind: 'apply' }
  | { kind: 'rollback'; label: string; preview: RollbackPreview }
  | null

export function HarnessCard({ harness, serverUrl, tokens, models: initialModels }: { harness: HarnessId; serverUrl: string | null; tokens: TokenOption[]; models: string[] }) {
  const { t } = useTranslation()
  const [providerModels, setProviderModels] = useState<string[] | null>(null)
  const models = providerModels ?? initialModels
  const meta = META[harness]
  const isCodex = harness === 'codex'
  const title = HARNESS_TITLE[harness]
  const [det, setDet] = useState<Detection | null>(null)
  const [, setKr] = useState<KeyringStatus | null>(null)
  const [tokenId, setTokenId] = useState<number | null>(null)
  const [main, setMain] = useState(harness === 'claude' ? 'claude-main-placeholder' : '')
  const [small, setSmall] = useState(harness === 'claude' ? 'claude-small-placeholder' : '')
  const [profileId, setProfileId] = useState<string | undefined>()
  const [paid, setPaid] = useState<HarnessTestResult | null>(null)
  const [unknownOk, setUnknownOk] = useState(false)
  const [opus, setOpus] = useState('')
  const [sonnet, setSonnet] = useState('')
  const [custom, setCustom] = useState('')
  const [cxDefault, setCxDefault] = useState(false)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [acks, setAcks] = useState<Record<string, ConflictResolution>>({})
  const [hist, setHist] = useState<HarnessHistory | null>(null)
  const [rb, setRb] = useState<{ label: string; preview: RollbackPreview } | null>(null)
  const [channel, setChannel] = useState<HarnessChannelStatus>({ state: 'not-checked', checkedAt: '' })
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending>(null)
  const [overwriteOk, setOverwriteOk] = useState(false)

  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setMsg(null); setNote(null); setBusy(true)
    try { await fn() } catch (e) { setMsg(errText(e)) } finally { setBusy(false) }
  }, [])

  const loadData = useCallback(async () => {
    const d = await unwrap(pa().harness.detect())
    setDet(d.harnesses.find((h) => h.id === harness) ?? null)
    const k = await unwrap(pa().harness.keyringStatus({ profileId: PROFILE }))
    setKr(k)
    const p = (await unwrap(pa().harness.listProfiles())).profiles[0]
    if (p) {
      setTokenId(p.serverUrl === serverUrl ? p.keyId : null)
      if (p.serverUrl !== serverUrl) setMsg(t('Server changed; select a token again'))
      setMain(isCodex ? (p.models.codex ?? p.models.main) : p.models.main)
      setSmall(p.models.small ?? '')
      setOpus(p.models.opus ?? ''); setSonnet(p.models.sonnet ?? ''); setCustom(p.models.custom ?? '')
      setProfileId(p.id)
      const available = await unwrap(pa().harness.models({ profileId: p.id })).catch(() => null)
      if (available) setProviderModels(available.models)
      setCxDefault(p.codex?.setDefault === true)
    }
    setHist(await unwrap(pa().harness.history({ id: harness })).catch(() => null))
  }, [harness, isCodex, serverUrl, t])

  useEffect(() => { void run(loadData) }, [run, loadData])
  useEffect(() => { if (!main && models[0]) setMain(models[0]) }, [models, main])

  const doPlan = () => run(async () => {
    if (tokenId === null || !serverUrl) { setMsg(t('Select an API key first (create one on the API Keys page).')); return }
    const prev = (await unwrap(pa().harness.listProfiles())).profiles[0]
    // One shared profile: keep the other harnesses' options, replace only what this card edits.
    const profile: ProviderInput = {
      ...(prev ? { id: prev.id } : {}), label: prev?.label ?? 'Swift provider', keyId: tokenId,
      models: isCodex
        ? { ...prev?.models, main: prev?.models.main ?? main, codex: main }
        : { ...prev?.models, main, ...(small ? { small } : {}), ...(opus ? { opus } : {}), ...(sonnet ? { sonnet } : {}), ...(custom ? { custom } : {}) },
    }
    if (isCodex) profile.codex = { ...prev?.codex, setDefault: cxDefault }
    const saved = await unwrap(pa().harness.upsertProfile(profile))
    setProfileId(saved.id)
    setAcks({}); setRb(null)
    setPlan(await unwrap(pa().harness.plan({ id: harness, profileId: saved.id })))
  })

  const doApply = () => run(async () => {
    if (!plan) return
    const r = await unwrap(pa().harness.apply({
      id: harness, plan, confirm: true,
      acknowledge: Object.entries(acks).map(([conflictId, resolution]) => ({ conflictId, resolution })),
    }))
    setPlan(null)
    await loadData()
    if (profileId) {
      await unwrap(pa().harness.test({ id: harness, profileId, level: 'L0' }))
      await unwrap(pa().harness.test({ id: harness, profileId, level: 'L1' }))
    }
    setNote(r.written.length ? `${t('Written')}: ${r.written.map(fileName).join(', ')}` : t('Nothing to write'))
  })

  const previewRollback = (target: RollbackTarget, label: string) => run(async () => {
    setPlan(null)
    setRb({ label, preview: await unwrap(pa().harness.rollbackPreview({ id: harness, target })) })
  })

  const doRollback = (preview: RollbackPreview, label: string) => run(async () => {
    const edited = preview.externalEdits ?? []
    const r = await unwrap(pa().harness.rollback({ id: harness, target: preview.target, confirm: true, ...(edited.length ? { overwriteExternal: true } : {}) }))
    setRb(null)
    await loadData()
    setNote(`${label}: ${r.written.map(fileName).join(', ') || t('no changes')}`)
  })

  const probe = () => run(async () => setChannel(await unwrap(pa().harness.probeChannel({ profileId: profileId ?? PROFILE }))))
  const unresolved = plan?.conflicts.some((c) => !acks[c.id] || acks[c.id] === 'cancel') ?? false
  const edited = pending?.kind === 'rollback' ? (pending.preview.externalEdits ?? []) : []

  return (
    <Card data-testid={`harness-card-${harness}`}>
      <CardHeader>
        <CardTitle className='flex items-center gap-2'>
          {title}
          {det && (det.installed
            ? <Badge variant='secondary'>{t('Installed')} {det.version ?? ''}</Badge>
            : <Badge variant='outline'>{t('Not detected')}</Badge>)}
          {hist && <Badge aria-label={t('Managed status')} variant={hist.attached ? 'default' : 'outline'}>{hist.attached ? t('Managed') : t('Not managed')}</Badge>}
        </CardTitle>
        <CardDescription>
          {t('Config dir')} <code className='text-xs'>{det?.configDir ?? '…'}</code>
          {' · '}{t('Private plaintext key file')}
        </CardDescription>
        <CardAction>
          <Button variant='ghost' size='icon-sm' aria-label={t('Refresh')} disabled={busy} onClick={() => void run(loadData)}>
            {busy ? <Loader2 className='size-4 animate-spin' /> : <RefreshCw className='size-4' />}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className='space-y-4'>
        {det && !det.installed && <p className='text-muted-foreground text-sm'>{t('{{bin}} not detected: the config can still be written and will be used once installed.', { bin: meta.bin })}</p>}
        {det?.notes.map((n) => <p key={n} className='text-muted-foreground text-xs'>{n}</p>)}
        {isCodex && (
          <div role='status' className='flex flex-wrap items-center gap-2 text-sm'>
            <Badge variant={channel.state === 'model-listed' ? 'default' : 'outline'}>{t(CHANNEL[channel.state])}{channel.model ? `: ${channel.model}` : ''}</Badge>
            {channel.checkedAt && <span className='text-muted-foreground text-xs'>{when(channel.checkedAt)}</span>}
            <Button variant='outline' size='sm' disabled={busy} onClick={() => void probe()}>{t('Probe server channel')}</Button>
          </div>
        )}

        <div className='grid gap-3 sm:grid-cols-2'>
          <div className='space-y-1.5'>
            <Label htmlFor={`${harness}-token`}>{t('API key')}</Label>
            <NativeSelect id={`${harness}-token`} aria-label={t('API key')} className='w-full' value={tokenId ?? ''} onChange={(e) => setTokenId(e.target.value ? Number(e.target.value) : null)}>
              <NativeSelectOption value=''>{t(tokens.length ? 'Select an API key' : 'No API keys')}</NativeSelectOption>
              {tokens.map((k) => <NativeSelectOption key={k.id} value={k.id}>{k.name} ({k.maskedKey})</NativeSelectOption>)}
            </NativeSelect>
          </div>
          <div className='space-y-1.5'>
            <Label htmlFor={`${harness}-main`}>{isCodex ? t('Codex model') : t('Main model')}</Label>
            {models.length > 0 ? (
              <NativeSelect id={`${harness}-main`} aria-label={t('Main model')} className='w-full' value={main} onChange={(e) => setMain(e.target.value)}>
                {models.map((m) => <NativeSelectOption key={m} value={m}>{m}</NativeSelectOption>)}
                {main && !models.includes(main) && <NativeSelectOption value={main}>{main.includes('placeholder') ? t('Pending — choose model') : main}</NativeSelectOption>}
              </NativeSelect>
            ) : (
              // No model listed for this account (e.g. no channel yet): allow typing the model name.
              <Input id={`${harness}-main`} aria-label={t('Main model')} placeholder={t('model name')} value={main} onChange={(e) => setMain(e.target.value)} spellCheck={false} />
            )}
          </div>
          {meta.small && (
            <div className='space-y-1.5'>
              <Label htmlFor={`${harness}-small`}>{t(meta.small)}</Label>
              <NativeSelect id={`${harness}-small`} aria-label={t('Secondary model')} className='w-full' value={small} onChange={(e) => setSmall(e.target.value)}>
                {small.includes('placeholder') && <NativeSelectOption value={small}>{t('Pending — choose model')}</NativeSelectOption>}
                <NativeSelectOption value=''>{t('(none)')}</NativeSelectOption>
                {models.map((m) => <NativeSelectOption key={m} value={m}>{m}</NativeSelectOption>)}
              </NativeSelect>
            </div>
          )}

        </div>
        {harness === 'claude' && <div className='grid gap-3 sm:grid-cols-3'>
          <Label>Opus<Input aria-label='Opus model' value={opus} onChange={(e) => setOpus(e.target.value)} /></Label>
          <Label>Sonnet<Input aria-label='Sonnet model' value={sonnet} onChange={(e) => setSonnet(e.target.value)} /></Label>
          <Label>{t('Custom model option')}<Input aria-label={t('Custom model option')} value={custom} onChange={(e) => setCustom(e.target.value)} /></Label>
        </div>}
        {isCodex && (
          <Label className='text-sm font-normal'>
            <Checkbox aria-label={t('Set as Codex default')} checked={cxDefault} onCheckedChange={(v) => setCxDefault(v === true)} />
            {t('Set as Codex default (rewrites model / model_provider)')}
          </Label>
        )}
        <div className='flex gap-2'>
          <Button variant='outline' disabled={busy || !profileId} onClick={() => void run(async () => { const result = await unwrap(pa().harness.test({ id: harness, profileId: profileId ?? '', level: 'L1' })); setNote(result.state) })}>{t('Test connection (free)')}</Button>
          <Button variant='outline' disabled={busy || !profileId} onClick={() => void run(async () => { setUnknownOk(false); const quote = await unwrap(pa().harness.test({ id: harness, profileId: profileId ?? '', level: 'L2' })); if (quote.state === 'confirmation-required') setPaid(quote); else setNote(quote.state) })}>{t('Run paid test')}</Button>
          <Button disabled={!main || busy} onClick={() => void doPlan()}>{t('Preview changes')}</Button>
        </div>

        <ConfirmDialog open={!!paid} onOpenChange={(v) => { if (!v) setPaid(null) }} title={t('Run paid test')} desc={`${paid?.requestCount ?? 0} requests · ${paid?.model ?? ''} · ${paid?.tokenCap ?? 0} tokens maximum · ${paid?.estimatedCost == null ? t('Cost unknown') : `USD ${paid.estimatedCost.toFixed(6)} (estimate)`}${paid?.priceTableDate ? ` · ${paid.priceTableDate} (may be outdated)` : ''}`} confirmText={t('Run paid test')} disabled={busy || (paid?.estimatedCost == null && !unknownOk)} handleConfirm={() => { const q = paid; setPaid(null); if (q && profileId) void run(async () => { const r = await unwrap(pa().harness.test({ id: harness, profileId, level: 'L2', confirm: true, quoteId: q.quoteId, confirmUnknownCost: unknownOk })); setNote(`${r.state} · ${r.requestCount} requests`) }) }}>
          {paid?.estimatedCost == null && <Label><Checkbox checked={unknownOk} onCheckedChange={(v) => setUnknownOk(v === true)} />{t('I accept unknown cost within the displayed token cap')}</Label>}
        </ConfirmDialog>
        {plan && (
          <div className='space-y-3 rounded-md border p-3' role='region' aria-label={t('Change preview')}>
            <DiffTable changes={plan.changes} label={t('Change preview')} />
            {plan.conflicts.map((c) => (
              <Alert key={c.id} variant='destructive' role='alert'>
                <AlertDescription className='flex flex-wrap items-center gap-2'>
                  {t('Conflict')}: {c.message}
                  <NativeSelect size='sm' aria-label={`${t('Conflict resolution')} ${c.id}`} value={acks[c.id] ?? 'cancel'} onChange={(e) => setAcks({ ...acks, [c.id]: e.target.value as ConflictResolution })}>
                    <NativeSelectOption value='cancel'>{t('Cancel')}</NativeSelectOption>
                    <NativeSelectOption value='overwrite'>{t('Overwrite')}</NativeSelectOption>
                    <NativeSelectOption value='keep-external'>{t('Keep external edit')}</NativeSelectOption>
                  </NativeSelect>
                </AlertDescription>
              </Alert>
            ))}
            {plan.externalUnownedChange.length > 0 && <p className='text-muted-foreground text-xs'>{t('Other (unmanaged) edits in these files are kept and merged.')}</p>}
            {plan.warnings.map((w) => <p key={w} className='text-sm text-amber-600 dark:text-amber-400'>{w}</p>)}
            <div className='flex items-center gap-2'>
              <Button disabled={unresolved || busy} onClick={() => setPending({ kind: 'apply' })}>{t('Apply')}</Button>
              <Button variant='outline' onClick={() => setPlan(null)}>{t('Cancel')}</Button>
              {unresolved && <span className='text-sm text-amber-600 dark:text-amber-400'>{t('Resolve all conflicts first')}</span>}
            </div>
          </div>
        )}

        <details open={!!rb} className='rounded-md border p-3'>
          <summary className='cursor-pointer text-sm font-medium'>{t('Rollback & restore')}</summary>
          <div className='mt-3 flex flex-wrap gap-2'>
            <Button variant='outline' size='sm' disabled={busy || !hist?.snapshots.some((x) => x.action === 'apply')} onClick={() => void previewRollback('last', t('Roll back to previous version'))}>{t('Roll back to previous version')}</Button>
            <Button variant='outline' size='sm' disabled={busy || hist?.firstWrite === false} onClick={() => void previewRollback('first-write', t('Restore to before first write'))}>{t('Restore to before first write')}</Button>
            <Button variant='outline' size='sm' disabled={busy || hist?.attached === false} onClick={() => void previewRollback('detach', t('Remove our settings'))}>{t('Remove our settings')}</Button>
          </div>
          {hist && (hist.snapshots.length ? (
            <ul aria-label={t('Snapshots')} className='mt-3 space-y-1 text-sm'>
              {hist.snapshots.map((x) => (
                <li key={x.snapshotId} className='flex items-center gap-2'>
                  <span>{when(x.at)} · {t(ACTION[x.action])}</span>
                  <code className='text-muted-foreground text-xs'>{x.snapshotId.slice(-6)}</code>
                  {x.available
                    ? <Button variant='ghost' size='sm' disabled={busy} onClick={() => void previewRollback({ snapshotId: x.snapshotId }, `${t('Restore snapshot')} ${when(x.at)}`)}>{t('Preview restore')}</Button>
                    : <span className='text-muted-foreground text-xs'>({t('pruned')})</span>}
                </li>
              ))}
            </ul>
          ) : <p className='text-muted-foreground mt-3 text-sm'>{t('No snapshots yet (created on first apply).')}</p>)}
          {rb && (
            <div role='region' aria-label={t('Rollback preview')} className='mt-3 space-y-2 border-l-2 border-amber-500 pl-3'>
              <p className='text-sm'><strong>{rb.label}</strong> · {t('preview (nothing written yet)')}</p>
              {rb.preview.files.length > 0 && <p className='text-muted-foreground text-xs'>{rb.preview.files.map((f) => `${fileName(f.path)} (${t(f.kind)})`).join(', ')}</p>}
              <DiffTable changes={rb.preview.changes} label={t('Rollback preview changes')} />
              {rb.preview.warnings.map((w) => <p key={w} className='text-sm text-amber-600 dark:text-amber-400'>{w}</p>)}
              {rb.preview.externalEdits?.length ? <p role='alert' className='text-sm text-amber-600 dark:text-amber-400'>{t('Edited after our last write; continuing discards those edits (snapshot first)')}: {rb.preview.externalEdits.map(fileName).join(', ')}</p> : null}
              {rb.preview.blocked && <p role='alert' className='text-destructive text-sm'>{t('Not possible')}: {rb.preview.blocked}</p>}
              <div className='flex gap-2'>
                <Button size='sm' disabled={busy || !!rb.preview.blocked} onClick={() => { setOverwriteOk(false); setPending({ kind: 'rollback', label: rb.label, preview: rb.preview }) }}>{t('Confirm')}: {rb.label}</Button>
                <Button size='sm' variant='outline' onClick={() => setRb(null)}>{t('Cancel')}</Button>
              </div>
            </div>
          )}
        </details>

        {note && <p className='text-sm' role='status'>{note}</p>}
        {msg && <Alert variant='destructive'><AlertDescription>{msg}</AlertDescription></Alert>}
      </CardContent>

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(o) => { if (!o) setPending(null) }}
        title={pending?.kind === 'rollback' ? pending.label : t('Apply to {{title}}?', { title })}
        desc={pending?.kind === 'apply'
          ? t('This modifies the {{title}} config files (backed up automatically).', { title })
          : t('Current config is snapshotted first; you can roll back again.')}
        confirmText={t('Confirm')}
        destructive={edited.length > 0}
        disabled={edited.length > 0 && !overwriteOk}
        handleConfirm={() => {
          const p = pending
          setPending(null)
          if (p?.kind === 'apply') void doApply()
          else if (p?.kind === 'rollback') void doRollback(p.preview, p.label)
        }}
      >
        {edited.length > 0 && (
          // Aegis #1: files edited after our last write are only overwritten after an explicit second confirmation.
          <Label className='text-sm font-normal'>
            <Checkbox aria-label={t('Discard external edits')} checked={overwriteOk} onCheckedChange={(v) => setOverwriteOk(v === true)} />
            {t('Discard edits made after our last write in')}: {edited.map(fileName).join(', ')}
          </Label>
        )}
      </ConfirmDialog>
    </Card>
  )
}
