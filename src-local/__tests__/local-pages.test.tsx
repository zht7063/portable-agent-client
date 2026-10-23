/* portable-agent-client local pages (AGPL-3.0-only). */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiKeyCell } from '@/features/keys/components/api-keys-cells'

import { HarnessCard } from '../harness/harness-card'
import { KeychainSection } from '../keychain/keychain-section'
import { isPaDesktop } from '../lib/pa'
import { ServerSettingsCard } from '../server/server-settings'
import { paShowKey, paStoreKey } from '../tokens/key-actions'
import { PaApiKeyCell } from '../tokens/pa-token-actions'
import { fail, installFakePa, removeFakePa } from './fake-pa'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))
import { toast } from 'sonner'

let fake: ReturnType<typeof installFakePa>
let clip: ReturnType<typeof vi.fn>
beforeEach(() => {
  fake = installFakePa()
  clip = vi.fn(() => Promise.resolve())
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: clip }, configurable: true })
  vi.mocked(toast.success).mockClear(); vi.mocked(toast.error).mockClear()
})
afterEach(() => removeFakePa())

const apiKey = { id: 7, name: 'dev', key: 'ab**********yz' }

describe('token actions (desktop)', () => {
  it('key cell shows only the masked key; copy goes through main, never the renderer clipboard', async () => {
    render(<PaApiKeyCell apiKey={apiKey} />)
    expect(screen.getByTestId('pa-masked-key')).toHaveTextContent('sk-ab**********yz')
    fireEvent.click(screen.getByRole('button', { name: 'Copy API key' }))
    await waitFor(() => expect(fake.keys.copy).toHaveBeenCalledWith({ tokenId: 7 }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Copied. The clipboard is cleared in 30s.'))
    expect(clip).not.toHaveBeenCalled()
  })

  it('patched upstream ApiKeyCell renders the desktop cell (no masked-value popover copy)', () => {
    render(<ApiKeyCell apiKey={{ ...apiKey, status: 1 } as never} />)
    expect(screen.getByTestId('pa-masked-key')).toBeInTheDocument()
  })

  it('show key asks main (native dialogs); a cancel is silent', async () => {
    await paShowKey(7)
    expect(fake.keys.show).toHaveBeenCalledWith({ tokenId: 7 })
    fake.keys.show.mockImplementationOnce(() => fail('CANCELLED', 'not confirmed') as never)
    await paShowKey(7)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('store to keychain uses the default profile and reports the masked key', async () => {
    await paStoreKey(7, 'codex', (s, o) => s.replace('{{key}}', String(o?.key)).replace('{{h}}', String(o?.h)))
    expect(fake.keys.store).toHaveBeenCalledWith({ tokenId: 7, harness: 'codex', profileId: 'default' })
    expect(toast.success).toHaveBeenCalledWith('Stored sk-ab**********yz in the keychain for Codex')
  })

  it('isPaDesktop follows the bridge', () => {
    expect(isPaDesktop()).toBe(true)
    removeFakePa()
    expect(isPaDesktop()).toBe(false)
  })
})

describe('server settings', () => {
  it('shows server, version/compat and the HTTP warning', async () => {
    const { container } = render(<ServerSettingsCard />)
    expect(await screen.findByTestId('current-server')).toHaveTextContent('http://127.0.0.1:3000')
    expect(screen.getByTestId('verdict')).toHaveTextContent('Compatible')
    expect(screen.getByText('Not using HTTPS')).toBeInTheDocument()
    expect(container.textContent).toContain('v0.12.0-rc.46 · New API')
  })

  it('URL change goes to main (which confirms natively); cancel saves nothing', async () => {
    render(<ServerSettingsCard />)
    const input = await screen.findByLabelText('Server URL')
    fake.config.set.mockImplementationOnce(() => fail('CANCELLED', 'Server change not confirmed; not saved') as never)
    fireEvent.change(input, { target: { value: 'https://other.example' } })
    fireEvent.click(screen.getByRole('button', { name: 'Change server' }))
    expect(await screen.findByText('Server change cancelled; nothing saved.')).toBeInTheDocument()
    expect(fake.config.set).toHaveBeenCalledWith({ serverUrl: 'https://other.example' })
      })

  it('accepted URL change reloads status and notifies', async () => {
    const onChanged = vi.fn()
    render(<ServerSettingsCard onChanged={onChanged} />)
    fireEvent.change(await screen.findByLabelText('Server URL'), { target: { value: 'https://other.example' } })
    fireEvent.click(screen.getByRole('button', { name: 'Change server' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(fake.server.status).toHaveBeenLastCalledWith({ recheck: true })
  })

  it('saves the clipboard auto-clear duration', async () => {
    render(<ServerSettingsCard />)
    const input = await screen.findByLabelText(/Clear copied keys/)
    fireEvent.change(input, { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(fake.config.set).toHaveBeenCalledWith({ clipboardClearSeconds: 0 }))
    expect(await screen.findByText('Clipboard auto-clear disabled.')).toBeInTheDocument()
  })
})

describe('keychain section', () => {
  it('lists masked entries and removes one', async () => {
    render(<KeychainSection />)
    expect(await screen.findByText('sk-ab**********yz')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Claude Code' }))
    await waitFor(() => expect(fake.keys.remove).toHaveBeenCalledWith({ harness: 'claude' }))
  })
})

describe('harness card', () => {
  it('previews a masked diff and applies only after confirmation', async () => {
    render(<HarnessCard harness='claude' serverUrl='http://127.0.0.1:3000' tokens={[{ id: 7, name: 'dev', maskedKey: 'sk-ab**********yz' }]} models={['gpt-x']} />)
    await waitFor(() => expect(fake.harness.detect).toHaveBeenCalled())
    fireEvent.click(await screen.findByRole('button', { name: 'Preview changes' }))
    await waitFor(() => expect(fake.harness.plan).toHaveBeenCalledWith({ id: 'claude', profileId: 'default' }))
    expect(fake.harness.upsertProfile).toHaveBeenCalledWith(expect.objectContaining({ id: 'default', keyId: 7, models: expect.objectContaining({ main: 'gpt-x' }) }))
    expect(await screen.findByText('env.ANTHROPIC_BASE_URL')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(fake.harness.apply).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(fake.harness.apply).toHaveBeenCalledWith(expect.objectContaining({ id: 'claude', confirm: true })))
    expect(await screen.findByText(/Written: settings\.json/)).toBeInTheDocument()
  })

  it('shows bridge errors instead of failing silently', async () => {
    fake.harness.detect.mockImplementationOnce(() => fail('SERVER', 'detect failed') as never)
    render(<HarnessCard harness='pi' serverUrl={null} tokens={[]} models={[]} />)
    expect(await screen.findByText('detect failed')).toBeInTheDocument()
  })
})
