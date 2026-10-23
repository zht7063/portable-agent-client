/* portable-agent-client local pages (AGPL-3.0-only). Patches 0004 (sign-in link) and 0005 (dashboard copy curl). */
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { paCopyCurl } from '../tokens/key-actions'
import { installFakePa, removeFakePa } from './fake-pa'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock('@tanstack/react-router', () => ({
  Link: (p: { to: string; children: unknown; className?: string }) => <a href={p.to}>{p.children as never}</a>,
  useSearch: () => ({ redirect: undefined }),
}))
vi.mock('@/hooks/use-status', () => ({ useStatus: () => ({ status: { register_enabled: false } }) }))
vi.mock('@/features/auth/auth-layout', () => ({ AuthLayout: (p: { children: unknown }) => <div>{p.children as never}</div> }))
vi.mock('@/features/auth/components/terms-footer', () => ({ TermsFooter: () => null }))
vi.mock('@/features/auth/sign-in/components/user-auth-form', () => ({ UserAuthForm: () => <form /> }))
import { toast } from 'sonner'

import { SignIn } from '@/features/auth/sign-in'

let clip: ReturnType<typeof vi.fn>
beforeEach(() => {
  clip = vi.fn(() => Promise.resolve())
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: clip }, configurable: true })
})
afterEach(() => removeFakePa())

describe('patch 0004: sign-in server settings link', () => {
  it('desktop shows a link to /pa-server', () => {
    installFakePa()
    render(<SignIn />)
    expect(screen.getByRole('link', { name: 'Server settings' })).toHaveAttribute('href', '/pa-server')
  })
  it('web build (no bridge) shows no link', () => {
    render(<SignIn />)
    expect(screen.queryByRole('link', { name: 'Server settings' })).toBeNull()
  })
})

describe('patch 0005: dashboard copy curl', () => {
  it('goes to main with token id + endpoint/model; never touches the renderer clipboard', async () => {
    const fake = installFakePa()
    expect(await paCopyCurl(7, 'https://api.example.com/v1/chat/completions', 'gpt-4.1-mini', (s, o) => s.replace('{{n}}', String(o?.n)))).toBe(true)
    expect(fake.keys.copy).toHaveBeenCalledWith({ tokenId: 7, curl: { endpoint: 'https://api.example.com/v1/chat/completions', model: 'gpt-4.1-mini' } })
    expect(toast.success).toHaveBeenCalledWith('Copied. The clipboard is cleared in 30s.')
    expect(clip).not.toHaveBeenCalled()
  })
})
