/*
 * portable-agent-client local pages (AGPL-3.0-only).
 * Server settings: current server, version/compatibility (public /api/status check cached in main), HTTP warning,
 * clipboard auto-clear. Changing the URL calls pa.config.set; main shows a native confirmation (Cancel default)
 * with the host and full URL, and validates (http/https, no user:pass@) before asking.
 */
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, ServerCog, XCircle } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { SectionPageLayout } from '@/components/layout'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

import { errText, pa, PaCallError, unwrap } from '../lib/pa'
import type { ClientConfig, ServerStatusRes, ServerVerdict } from '../lib/pa-types'

const VERDICT: Record<ServerVerdict, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  ok: { label: 'Compatible', variant: 'default' },
  untested: { label: 'Untested version', variant: 'secondary' },
  'too-old': { label: 'Too old', variant: 'destructive' },
  incompatible: { label: 'Incompatible', variant: 'destructive' },
  'not-new-api': { label: 'Not a new-api server', variant: 'destructive' },
  unreachable: { label: 'Unreachable', variant: 'destructive' },
}

export function ServerSettingsCard({ onChanged: _onChanged }: { onChanged?: () => void }) {
  const { t } = useTranslation()
  const [st, setSt] = useState<ServerStatusRes | null>(null)
  const [cfg, setCfg] = useState<ClientConfig | null>(null)
  const [url, setUrl] = useState('')
  const [clear, setClear] = useState('30')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const load = useCallback(async (recheck = false) => {
    const [s, c] = await Promise.all([unwrap(pa().server.status({ recheck })), unwrap(pa().config.get())])
    setSt(s); setCfg(c); setUrl(c.serverUrl ?? ''); setClear(String(c.clipboardClearSeconds))
  }, [])
  const run = async (fn: () => Promise<void>, cancelled = t('Server change cancelled; nothing saved.')) => {
    setBusy(true); setErr(null); setNote(null)
    try { await fn() } catch (e) {
      if (e instanceof PaCallError && e.code === 'CANCELLED') setNote(cancelled)
      else setErr(errText(e))
    } finally { setBusy(false) }
  }
  useEffect(() => { load().catch((e: unknown) => setErr(errText(e))) }, [load])

  const saveClear = () => run(async () => {
    const n = Number(clear)
    await unwrap(pa().config.set({ clipboardClearSeconds: n }))
    await load()
    setNote(n === 0 ? t('Clipboard auto-clear disabled.') : t('Copied keys are cleared from the clipboard after {{n}}s.', { n }))
  }, t('Clipboard auto-clear unchanged (not confirmed).'))

  const check = st?.check ?? null
  const v = check ? VERDICT[check.verdict] : null
  const insecure = (st?.insecureTransport ?? cfg?.insecureTransport) === true
  return (
    <Card data-testid='server-settings'>
      <CardHeader>
        <CardTitle className='flex items-center gap-2'><ServerCog className='size-4' />{t('Server')}</CardTitle>
        <CardDescription>{t('The new-api server this client signs in to. Passwords, the session and API keys are sent only to this server.')}</CardDescription>
        <CardAction>
          <Button variant='outline' size='sm' disabled={busy} onClick={() => void run(() => load(true))}>
            {busy ? <Loader2 className='size-4 animate-spin' /> : <RefreshCw className='size-4' />}{t('Re-check')}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className='space-y-5'>
        {insecure && st?.serverUrl && (
          <Alert variant='destructive' role='alert'>
            <AlertTriangle className='size-4' />
            <AlertTitle>{t('Not using HTTPS')}</AlertTitle>
            <AlertDescription>{t('Password and session travel in plain text. Use only on a trusted network.')}</AlertDescription>
          </Alert>
        )}

        <dl className='grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm'>
          <dt className='text-muted-foreground'>{t('Current server')}</dt>
          <dd className='font-mono break-all' data-testid='current-server'>{st?.serverUrl ?? t('(not configured)')}</dd>
          <dt className='text-muted-foreground'>{t('Server version')}</dt>
          <dd>{check?.serverVersion ?? '—'}{check?.systemName ? <span className='text-muted-foreground'> · {check.systemName}</span> : null}</dd>
          <dt className='text-muted-foreground'>{t('Compatibility')}</dt>
          <dd className='flex flex-wrap items-center gap-2'>
            {v ? <Badge variant={v.variant} data-testid='verdict'>{check?.allowLogin ? <CheckCircle2 className='size-3' /> : <XCircle className='size-3' />}{t(v.label)}</Badge> : <span>—</span>}
            {check && <span className='text-muted-foreground text-xs'>{check.allowLogin ? t('Sign-in allowed') : t('Sign-in blocked')} · {new Date(check.checkedAt).toLocaleTimeString()}</span>}
          </dd>
          <dt className='text-muted-foreground'>{t('Supported range')}</dt>
          <dd>{st ? `≥ ${st.compat.minServer} · ${t('pinned')} ${st.compat.tag}${st.compat.maxServerTested ? ` · ${t('tested up to')} ${st.compat.maxServerTested}` : ''} (${st.compat.policy})` : '—'}</dd>
          <dt className='text-muted-foreground'>{t('Client version')}</dt>
          <dd>{st?.clientVersion ?? '—'}</dd>
        </dl>
        {check?.messages.filter((m) => !m.includes('HTTPS')).map((m) => <p key={m} className='text-sm text-amber-600 dark:text-amber-400'>{m}</p>)}

        <div className='space-y-1.5'>
          <Label htmlFor='pa-server-url'>{t('Server URL')}</Label>
          <div className='flex gap-2'>
            <Input id='pa-server-url' placeholder='https://new-api.example.com' value={url} readOnly spellCheck={false} />
          </div>
          <p className='text-muted-foreground text-xs'>{t('Server origin is fixed in this build.')}</p>
        </div>

        <div className='space-y-1.5'>
          <Label htmlFor='pa-clip-clear'>{t('Clear copied keys from clipboard after (seconds, 0 = never)')}</Label>
          <div className='flex gap-2'>
            <Input id='pa-clip-clear' type='number' min={0} max={600} step={1} className='w-32' value={clear} onChange={(e) => setClear(e.target.value)} />
            <Button variant='outline' disabled={busy || clear === String(cfg?.clipboardClearSeconds)} onClick={() => void saveClear()}>{t('Save')}</Button>
          </div>
        </div>

        {note && <p role='status' className='text-sm'>{note}</p>}
        {err && <Alert variant='destructive'><AlertDescription>{err}</AlertDescription></Alert>}
      </CardContent>
    </Card>
  )
}

/** Inside the authenticated layout (sidebar entry). */
export function ServerPage() {
  const { t } = useTranslation()
  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>{t('Server settings')}</SectionPageLayout.Title>
      <SectionPageLayout.Content><ServerSettingsCard onChanged={() => window.location.assign('/sign-in')} /></SectionPageLayout.Content>
    </SectionPageLayout>
  )
}

/** Public (pre-login) variant: a fresh client has no server yet, so this must be reachable without a session. */
export function ServerSetupPage() {
  return (
    <div className='bg-background flex min-h-svh items-start justify-center p-6 sm:p-10'>
      <div className='w-full max-w-2xl space-y-4'>
        <ServerSettingsCard />
        <p className='text-center text-sm'>
          <a className='text-primary hover:underline' href='/sign-in'>← Sign in</a>
          {' · '}
          <a className='text-primary hover:underline' href='/pa-about'>About &amp; licenses</a>
        </p>
      </div>
    </div>
  )
}
