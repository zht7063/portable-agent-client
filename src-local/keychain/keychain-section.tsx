/*
 * portable-agent-client local pages (AGPL-3.0-only).
 * Keys section: keychain entries written by "Store to keychain" / harness apply. Metadata + masked key only.
 */
import { KeyRound, Loader2, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { SectionPageLayout } from '@/components/layout'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

import { errText, HARNESS_TITLE, pa, unwrap } from '../lib/pa'
import type { HarnessId, KeysListRes } from '../lib/pa-types'

export function KeychainSection() {
  const { t } = useTranslation()
  const [list, setList] = useState<KeysListRes | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setErr(null)
    try { setList(await unwrap(pa().keys.list())) } catch (e) { setErr(errText(e)) }
  }, [])
  useEffect(() => { void load() }, [load])

  const remove = async (harness: HarnessId) => {
    setBusy(true)
    try { await unwrap(pa().keys.remove({ harness })); await load() } catch (e) { setErr(errText(e)) } finally { setBusy(false) }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className='flex items-center gap-2'><KeyRound className='size-4' />{t('Keychain')}</CardTitle>
        <CardDescription>
          {!list && '…'}
          {list?.available && <>{t('Backend')}: <Badge variant='secondary'>{list.backend}</Badge> · {t('Profile')}: default</>}
          {list && !list.available && <>{t('System keychain unavailable; harnesses use env key mode (export PA_API_KEY). Nothing is stored in plaintext.')}{list.reason ? ` (${list.reason})` : ''}</>}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {err && <Alert variant='destructive' className='mb-3'><AlertDescription>{err}</AlertDescription></Alert>}
        {list && (list.entries.length ? (
          <Table aria-label={t('Keychain entries')}>
            <TableHeader>
              <TableRow>
                <TableHead>{t('Harness')}</TableHead><TableHead>{t('API key')}</TableHead><TableHead>{t('Key')}</TableHead>
                <TableHead>{t('Stored')}</TableHead><TableHead>{t('Status')}</TableHead><TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.entries.map((e) => (
                <TableRow key={`${e.profileId}/${e.harness}`}>
                  <TableCell>{HARNESS_TITLE[e.harness]}</TableCell>
                  <TableCell>{e.tokenName || `#${e.tokenId}`}</TableCell>
                  <TableCell className='font-mono text-xs'>{e.maskedKey}</TableCell>
                  <TableCell className='text-xs'>{new Date(e.storedAt).toLocaleString()}</TableCell>
                  <TableCell>{e.present ? <Badge>{t('Present')}</Badge> : <Badge variant='destructive'>{t('Missing')}</Badge>}</TableCell>
                  <TableCell className='text-right'>
                    <Button variant='ghost' size='icon-sm' aria-label={`${t('Remove')} ${HARNESS_TITLE[e.harness]}`} disabled={busy} onClick={() => void remove(e.harness)}>
                      {busy ? <Loader2 className='size-4 animate-spin' /> : <Trash2 className='size-4' />}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : <p className='text-muted-foreground text-sm'>{t('No keys stored yet. Use "Store to keychain" on the API Keys page.')}</p>)}
      </CardContent>
    </Card>
  )
}

export function KeychainPage() {
  const { t } = useTranslation()
  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>{t('Keychain')}</SectionPageLayout.Title>
      <SectionPageLayout.Content><KeychainSection /></SectionPageLayout.Content>
    </SectionPageLayout>
  )
}
