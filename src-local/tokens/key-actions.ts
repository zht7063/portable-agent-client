/*
 * portable-agent-client local pages (AGPL-3.0-only).
 * Full-key operations, all executed in main. The renderer passes a token id and gets masked info back.
 */
import { toast } from 'sonner'

import { errText, HARNESS_TITLE, pa, PaCallError, unwrap } from '../lib/pa'
import type { HarnessId } from '../lib/pa-types'

export interface KeyRef { id: number; name?: string; key: string }
export const maskedOf = (k: KeyRef) => (k.key.startsWith('sk-') ? k.key : `sk-${k.key}`)

export async function paCopyKey(tokenId: number, t: (s: string, o?: Record<string, unknown>) => string): Promise<boolean> {
  try {
    await unwrap(pa().keys.copy({ tokenId }))
    const c = await unwrap(pa().config.get()).catch(() => null)
    const n = c?.clipboardClearSeconds ?? 0
    toast.success(n > 0 ? t('Copied. The clipboard is cleared in {{n}}s.', { n }) : t('Copied'))
    return true
  } catch (e) { toast.error(errText(e)); return false }
}

export async function paShowKey(tokenId: number): Promise<void> {
  try { await unwrap(pa().keys.show({ tokenId })) } catch (e) { if (!(e instanceof PaCallError && e.code === 'CANCELLED')) toast.error(errText(e)) }
}

export async function paStoreKey(tokenId: number, harness: HarnessId, t: (s: string, o?: Record<string, unknown>) => string): Promise<void> {
  try {
    const r = await unwrap(pa().keys.store({ tokenId, harness, profileId: 'default' }))
    toast.success(t('Stored {{key}} in the keychain for {{h}}', { key: r.maskedKey, h: HARNESS_TITLE[harness] }))
  } catch (e) { toast.error(errText(e)) }
}


/** Dashboard "Copy curl": main fetches the key, builds the curl command and writes it to the clipboard (auto-clear). */
export async function paCopyCurl(tokenId: number, endpoint: string, model: string, t: (s: string, o?: Record<string, unknown>) => string): Promise<boolean> {
  try {
    await unwrap(pa().keys.copy({ tokenId, curl: { endpoint, model } }))
    const c = await unwrap(pa().config.get()).catch(() => null)
    const n = c?.clipboardClearSeconds ?? 0
    toast.success(n > 0 ? t('Copied. The clipboard is cleared in {{n}}s.', { n }) : t('Copied'))
    return true
  } catch (e) { toast.error(errText(e)); return false }
}
