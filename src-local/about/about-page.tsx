/*
 * portable-agent-client local pages (AGPL-3.0-only).
 * M6 About & licenses (plan v2 §5; AGPL-3.0 §5(a), §6, §13): states that this is a modified version of new-api,
 * keeps the upstream §7(b) attribution with its link, shows the Corresponding Source offer for this exact build and
 * lets the user read every bundled license text (served same-origin from the app).
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

import { errText, pa, unwrap } from '../lib/pa'
import type { AppAboutRes } from '../lib/pa-types'

const ext = 'text-primary underline underline-offset-4 break-all'

export function AboutCard() {
  const { t } = useTranslation()
  const [a, setA] = useState<AppAboutRes | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [open, setOpen] = useState<{ title: string; text: string } | null>(null)

  useEffect(() => { unwrap(pa().app.about()).then(setA).catch((e: unknown) => setErr(errText(e))) }, [])

  const show = async (f: { title: string; path: string }) => {
    try {
      const r = await fetch(f.path)
      if (!r.ok) throw new Error(`${r.status}`)
      setOpen({ title: f.title, text: await r.text() })
    } catch (e) { setErr(`${f.title}: ${errText(e)}`) }
  }

  if (err && !a) return <p role='alert' className='text-destructive text-sm'>{err}</p>
  if (!a) return <p className='text-muted-foreground text-sm'>{t('Loading')}</p>
  return (
    <Card>
      <CardHeader>
        <CardTitle>{a.productName} {a.version}</CardTitle>
        <CardDescription>{t('About & licenses')}</CardDescription>
      </CardHeader>
      <CardContent className='space-y-4 text-sm'>
        <section data-testid='pa-about-license' className='space-y-1'>
          <p>
            {a.productName} is free software: you can redistribute it and/or modify it under the terms of the GNU Affero
            General Public License version 3 ({a.license}). It comes with ABSOLUTELY NO WARRANTY; see the license for details.
          </p>
        </section>
        <section data-testid='pa-about-upstream' className='space-y-1'>
          <p>
            {a.productName} is based on {a.upstream.name} by {a.upstream.author} ({a.upstream.license}) and bundles a
            modified version of its web frontend ({a.upstream.tag}, {a.upstream.commit.slice(0, 12)}).
          </p>
          <p>{a.attribution}{' '}<a className={ext} href={a.upstream.repo} target='_blank' rel='noreferrer'>{a.upstream.repo}</a></p>
        </section>
        <section data-testid='pa-about-source' className='space-y-1'>
          <p className='font-medium'>{t('Source code')}</p>
          {a.sourceUrl
            ? <p>Corresponding Source: <a className={ext} href={a.sourceUrl} target='_blank' rel='noreferrer'>{a.sourceUrl}</a></p>
            : <p>Corresponding Source: not published yet.</p>}
          <p>Build commit: <code>{a.buildCommit}</code></p>
          {a.sourceOffer && <p className='text-muted-foreground'>{a.sourceOffer}</p>}
        </section>
        <section className='space-y-2'>
          <p className='font-medium'>{t('Licenses')}</p>
          <div className='flex flex-wrap gap-2'>
            {a.licenseFiles.map((f) => <Button key={f.path} variant='outline' size='sm' onClick={() => void show(f)}>{f.title}</Button>)}
          </div>
          {err && <p role='alert' className='text-destructive'>{err}</p>}
          {open && (
            <div className='space-y-1'>
              <p className='font-medium'>{open.title}</p>
              <pre data-testid='pa-license-text' className='bg-muted max-h-96 overflow-auto rounded p-3 text-xs whitespace-pre-wrap'>{open.text}</pre>
            </div>
          )}
        </section>
      </CardContent>
    </Card>
  )
}

/** Public route (reachable before sign-in and from Help -> About & licenses). */
export function AboutPage() {
  return (
    <div className='bg-background flex min-h-svh items-start justify-center p-6 sm:p-10'>
      <div className='w-full max-w-3xl space-y-4'>
        <AboutCard />
        <p className='text-center text-sm'><a className='text-primary hover:underline' href='/'>← Back</a></p>
      </div>
    </div>
  )
}
