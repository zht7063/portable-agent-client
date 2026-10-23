/* portable-agent-client local pages (AGPL-3.0-only). Patch 0006: chat presets / chat routes hidden in the desktop. */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { installFakePa, removeFakePa } from './fake-pa'

const getApiKeys = vi.fn()
const fetchTokenKey = vi.fn()
vi.mock('@/features/keys/api', () => ({ getApiKeys: (...a: unknown[]) => getApiKeys(...a), fetchTokenKey: (...a: unknown[]) => fetchTokenKey(...a) }))

import { fetchActiveChatKey } from '@/features/chat/hooks/use-active-chat-key'
import { resolveChatUrl } from '@/features/chat/lib/chat-links'
import { useSidebarData } from '@/hooks/use-sidebar-data'
import { Route as ChatRoute } from '@/routes/_authenticated/chat/$chatId'
import { Route as Chat2LinkRoute } from '@/routes/_authenticated/chat2link'

afterEach(() => { removeFakePa(); vi.clearAllMocks() })

const tpl = { template: 'https://chat.example.com/?key={key}&url={address}', apiKey: 'sk-abc', serverAddress: 'https://api.example.com' }
const chatItems = (d: ReturnType<typeof useSidebarData>) => d.navGroups.flatMap((g) => g.items).filter((i) => 'type' in i && i.type === 'chat-presets')

describe('patch 0006: chat links never built in the desktop', () => {
  it('resolveChatUrl returns empty in desktop, unchanged on web', () => {
    expect(resolveChatUrl(tpl)).toContain('key=sk-abc')
    installFakePa()
    expect(resolveChatUrl(tpl)).toBe('')
  })
  it('fetchActiveChatKey refuses in desktop without fetching any key', async () => {
    installFakePa()
    await expect(fetchActiveChatKey()).rejects.toThrow(/not available in the desktop/)
    expect(getApiKeys).not.toHaveBeenCalled()
    expect(fetchTokenKey).not.toHaveBeenCalled()
  })
  it('sidebar has no chat-presets entry in desktop; web keeps it', () => {
    expect(chatItems(renderHook(() => useSidebarData()).result.current)).toHaveLength(1)
    installFakePa()
    expect(chatItems(renderHook(() => useSidebarData()).result.current)).toHaveLength(0)
  })
  it('chat routes redirect to /dashboard in desktop; web passes', () => {
    for (const r of [ChatRoute, Chat2LinkRoute]) {
      const before = (r.options as { beforeLoad: () => void }).beforeLoad
      expect(() => before()).not.toThrow()
      installFakePa()
      let thrown: unknown
      try { before() } catch (e) { thrown = e }
      expect(JSON.stringify(thrown)).toContain('/dashboard')
      removeFakePa()
    }
  })
})

// Every remaining place that builds a link/handoff from a key must be gated for the desktop.
describe('no UI path puts a (masked) key into a link', () => {
  const root = join(__dirname, '..', '..')
  const files: string[] = []
  const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) { if (!['__tests__', 'pa-local', 'i18n'].includes(n)) walk(p) } else if (/\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n)) files.push(p) } }
  walk(root)
  const rel = (p: string) => p.slice(root.length + 1)
  it('call sites of resolveChatUrl / sendToFluent / fetchActiveChatKey / encodeChannelConnectionInfo are known and gated', () => {
    const sinks = /\b(resolveChatUrl|sendToFluent|fetchActiveChatKey|encodeChannelConnectionInfo)\(/
    const users = files.filter((f) => sinks.test(readFileSync(f, 'utf8'))).map(rel).sort()
    // resolveChatUrl itself + fetchActiveChatKey itself refuse in desktop (patch 0006); the rest are behind isPaDesktop() branches.
    // Definitions refuse in desktop (patch 0006) or are only reachable from desktop-gated callers; a new call site fails here until reviewed.
    expect(users).toEqual([
      'components/layout/components/chat-presets-item.tsx', // nav-group returns null for it in desktop; resolveChatUrl returns ''
      'features/chat/hooks/use-active-chat-key.ts', // definition; throws in desktop
      'features/chat/lib/chat-links.ts', // definition; '' in desktop
      'features/chat/lib/send-to-fluent.ts', // definition; only caller is the web-only branch of row actions
      'features/keys/components/data-table-row-actions.tsx', // desktop renders PaTokenMenuItems instead (patch 0003)
      'lib/channel-connection-info.ts', // definition; only caller is the web-only branch of row actions
      'routes/_authenticated/chat/$chatId.tsx', // redirect in desktop
      'routes/_authenticated/chat2link.tsx', // redirect in desktop
    ])
    for (const f of ['routes/_authenticated/chat/$chatId.tsx', 'routes/_authenticated/chat2link.tsx', 'features/chat/lib/chat-links.ts', 'features/chat/hooks/use-active-chat-key.ts', 'components/layout/components/nav-group.tsx']) {
      expect(readFileSync(join(root, f), 'utf8')).toContain('isPaDesktop()')
    }
    expect(readFileSync(join(root, 'features/keys/components/data-table-row-actions.tsx'), 'utf8')).toMatch(/isPaDesktop\(\) \?\s*\(\s*<PaTokenMenuItems/)
  })
})
