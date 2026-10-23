/*
 * portable-agent-client local pages (AGPL-3.0-only).
 * Desktop replacements for the API Keys page key actions. The renderer only ever sees the masked key
 * (`sk-` + upstream's masked `key`); every full-key operation happens in main:
 *  - Copy key        -> pa.keys.copy   (main writes the clipboard; auto-cleared after clipboardClearSeconds)
 *  - Show key        -> pa.keys.show   (native confirm, then a native message box; nothing returned to the renderer)
 *  - Store to keychain -> pa.keys.store (single 'default' profile)
 */
import { Check, Copy, Eye, KeyRound, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

import { HARNESS_IDS, HARNESS_TITLE } from '../lib/pa'
import { type KeyRef, maskedOf, paCopyKey, paShowKey, paStoreKey } from './key-actions'

/** Key cell: masked value + copy (via main). No popover with a "full" key, which would only ever be masked here. */
export function PaApiKeyCell({ apiKey }: { apiKey: KeyRef }) {
  const { t } = useTranslation()
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle')
  const copy = async () => {
    setState('busy')
    const ok = await paCopyKey(apiKey.id, t)
    setState(ok ? 'done' : 'idle')
    if (ok) setTimeout(() => setState('idle'), 1500)
  }
  return (
    <div className='flex max-w-full min-w-0 items-center'>
      <span className='truncate font-mono text-xs' data-testid='pa-masked-key'>{maskedOf(apiKey)}</span>
      <Tooltip>
        <TooltipTrigger render={<Button variant='ghost' size='icon' className='size-7 shrink-0' onClick={copy} disabled={state === 'busy'} aria-label={t('Copy API key')} />}>
          {state === 'busy' && <Loader2 className='size-3.5 animate-spin' />}{state === 'done' && <Check className='size-3.5 text-green-600' />}{state === 'idle' && <Copy className='size-3.5' />}
        </TooltipTrigger>
        <TooltipContent>{t('Copy API key')}</TooltipContent>
      </Tooltip>
    </div>
  )
}

/** Row menu items replacing upstream Copy Key / Copy Connection Info / CC Switch / Chat presets in the desktop. */
export function PaTokenMenuItems({ apiKey }: { apiKey: KeyRef }) {
  const { t } = useTranslation()
  return (
    <>
      <DropdownMenuItem onClick={() => void paCopyKey(apiKey.id, t)}>
        {t('Copy Key')}
        <DropdownMenuShortcut><Copy size={16} /></DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => void paShowKey(apiKey.id)}>
        {t('Show Key…')}
        <DropdownMenuShortcut><Eye size={16} /></DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuSub>
        <DropdownMenuSubTrigger><KeyRound size={16} className='mr-2' />{t('Store to keychain')}</DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          {HARNESS_IDS.map((h) => (
            <DropdownMenuItem key={h} onClick={() => void paStoreKey(apiKey.id, h, t)}>{HARNESS_TITLE[h]}</DropdownMenuItem>
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </>
  )
}
