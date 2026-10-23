/*
 * portable-agent-client local pages (AGPL-3.0-only).
 * Masked per-setting diff (apply and rollback previews). Values are already masked by main.
 */
import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

import { fileName } from '../lib/pa'
import type { PlannedKeyChange } from '../lib/pa-types'

const KIND_VARIANT = { create: 'default', modify: 'secondary', remove: 'destructive', unchanged: 'outline' } as const

export function DiffTable({ changes, label }: { changes: PlannedKeyChange[]; label: string }) {
  const { t } = useTranslation()
  const shown = changes.filter((c) => c.kind !== 'unchanged')
  if (!shown.length) return <p className='text-muted-foreground text-sm'>{t('No changes to managed settings')}</p>
  return (
    <Table aria-label={label}>
      <TableHeader>
        <TableRow>
          <TableHead>{t('File')}</TableHead>
          <TableHead>{t('Setting')}</TableHead>
          <TableHead>{t('Change')}</TableHead>
          <TableHead>{t('Before')}</TableHead>
          <TableHead>{t('After')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {shown.map((c) => (
          <TableRow key={`${c.file}#${c.setting}`}>
            <TableCell title={c.file}>{fileName(c.file)}</TableCell>
            <TableCell><code className='text-xs'>{c.setting}</code></TableCell>
            <TableCell><Badge variant={KIND_VARIANT[c.kind]}>{t(c.kind)}</Badge></TableCell>
            <TableCell className='font-mono text-xs break-all whitespace-normal'>{c.before ?? '—'}</TableCell>
            <TableCell className='font-mono text-xs break-all whitespace-normal'>{c.after ?? '—'}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
