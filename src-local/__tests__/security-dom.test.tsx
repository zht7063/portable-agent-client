/* portable-agent-client local pages (AGPL-3.0-only). M7 leak regression (DOM): after every desktop key action the
 * document holds no full key / access token / cookie, no link carries a key (masked or not), and the renderer never
 * fetches a full key itself. */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiKeyCell } from '@/features/keys/components/api-keys-cells'

import { HarnessCard } from '../harness/harness-card'
import { KeychainSection } from '../keychain/keychain-section'
import { ServerSettingsCard } from '../server/server-settings'
import { paCopyCurl, paShowKey, paStoreKey } from '../tokens/key-actions'
import { installFakePa, removeFakePa } from './fake-pa'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))

const RAW = 'Lk9' + 'q'.repeat(42) + 'Zz1'
const AT = 'AT0' + 'x'.repeat(40) + 'END'
const KEYISH = /\b(sk-)?[A-Za-z0-9]{40,}\b|pac-h\.|session=|new_api_refresh/

let fetchSpy: ReturnType<typeof vi.fn>
beforeEach(() => {
  installFakePa()
  fetchSpy = vi.fn(() => Promise.reject(new Error('renderer fetch not expected')))
  vi.stubGlobal('fetch', fetchSpy)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(() => Promise.resolve()) }, configurable: true })
})
afterEach(() => { removeFakePa(); vi.unstubAllGlobals() })

function assertDomClean() {
  const html = document.documentElement.outerHTML
  for (const s of [RAW, AT]) expect(html).not.toContain(s)
  expect(html).not.toMatch(KEYISH)
  for (const a of document.querySelectorAll('a[href], iframe[src], form[action]')) {
    const u = a.getAttribute('href') ?? a.getAttribute('src') ?? a.getAttribute('action') ?? ''
    expect(u, u).not.toMatch(/\*{4}|[?&](key|apikey|api_key|token)=|sk-/i)
  }
}

describe('DOM leak regression (desktop)', () => {
  it('key cell + copy / show / store / copy-curl: DOM clean, no renderer key fetch, no renderer clipboard write', async () => {
    render(<ApiKeyCell apiKey={{ id: 7, name: 'dev', key: 'Lk9q**********qZz1', status: 1 } as never} />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy API key' }))
    await paShowKey(7)
    await paStoreKey(7, 'codex', (s) => s)
    await paCopyCurl(7, 'https://api.example.com/v1/chat/completions', 'm', (s) => s)
    await waitFor(() => expect(window.pa?.keys.copy).toHaveBeenCalled())
    assertDomClean()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
  })
  it('local pages (keychain, harness, server settings) render only masked data and no key-bearing links', async () => {
    render(<><KeychainSection /><HarnessCard harness='claude' serverUrl='http://127.0.0.1:3000' tokens={[{ id: 7, name: 'dev', maskedKey: 'sk-ab**********yz' }]} models={['gpt-x']} /><ServerSettingsCard /></>)
    await waitFor(() => expect(screen.getAllByText(/sk-ab\*+yz/).length).toBeGreaterThan(0))
    assertDomClean()
  })
})
