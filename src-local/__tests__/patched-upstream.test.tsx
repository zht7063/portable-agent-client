/* portable-agent-client local pages (AGPL-3.0-only). Patches 0004 (sign-in link). */
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { installFakePa, removeFakePa } from './fake-pa'

vi.mock('@tanstack/react-router', () => ({
  Link: (p: { to: string; children: unknown; className?: string }) => <a href={p.to}>{p.children as never}</a>,
  useSearch: () => ({ redirect: undefined }),
}))
vi.mock('@/hooks/use-status', () => ({ useStatus: () => ({ status: { register_enabled: false } }) }))
vi.mock('@/features/auth/auth-layout', () => ({ AuthLayout: (p: { children: unknown }) => <div>{p.children as never}</div> }))
vi.mock('@/features/auth/components/terms-footer', () => ({ TermsFooter: () => null }))
vi.mock('@/features/auth/sign-in/components/user-auth-form', () => ({ UserAuthForm: () => <form /> }))

import { SignIn } from '@/features/auth/sign-in'

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
