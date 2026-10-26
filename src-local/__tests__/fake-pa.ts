/* portable-agent-client local pages (AGPL-3.0-only). Test helper: a fake preload bridge (window.pa). */
import { vi } from 'vitest'

const ok = <T,>(data: T) => Promise.resolve({ ok: true as const, data })
export const fail = (code: string, message: string) => Promise.resolve({ ok: false as const, error: { code, message } })

export function installFakePa() {
  const cfg = { serverUrl: 'http://127.0.0.1:3000', insecureTransport: true, clipboardClearSeconds: 30 }
  const fake = {
    config: {
      get: vi.fn(() => ok({ ...cfg })),
      set: vi.fn((r: { serverUrl?: string; clipboardClearSeconds?: number }) => { Object.assign(cfg, r); return ok({ ...cfg }) }),
    },
    harness: {
      detect: vi.fn(() => ok({ harnesses: ['pi', 'claude', 'codex'].map((id) => ({ id, installed: id !== 'pi', version: id === 'pi' ? null : '1.0.0', configDir: `/tmp/h/.${id}`, notes: [] })), registered: ['pi', 'claude', 'codex'] })),
      plan: vi.fn((r: { id: string }) => ok({ id: r.id, changes: [{ file: `/tmp/h/.${r.id}/settings.json`, setting: 'env.ANTHROPIC_BASE_URL', kind: 'create', before: null, after: 'http://127.0.0.1:3000' }], conflicts: [], externalUnownedChange: [], warnings: [] })),
      apply: vi.fn((r: { id: string }) => ok({ id: r.id, written: [`/tmp/h/.${r.id}/settings.json`], snapshotId: 's1', warnings: [] })),
      rollback: vi.fn(() => ok({ id: 'claude', written: [], warnings: [] })),
      history: vi.fn((r: { id: string }) => ok({ id: r.id, snapshots: [], firstWrite: false, attached: false })),
      rollbackPreview: vi.fn(() => ok({ target: 'last', files: [], changes: [], warnings: [] })),
      keyringStatus: vi.fn(() => ok({ available: true, backend: 'secret-service' })),
      listProfiles: vi.fn(() => ok({ profiles: [] })),
      upsertProfile: vi.fn((p: unknown) => ok(p)),
      probeChannel: vi.fn(() => ok({ state: 'model-listed', model: 'gpt-x', checkedAt: new Date().toISOString() })),
    },
    keys: {
      list: vi.fn(() => ok({ available: true, backend: 'secret-service', entries: [{ profileId: 'default', harness: 'claude', tokenId: 7, tokenName: 'dev', maskedKey: 'sk-ab**********yz', storedAt: '2026-10-24T00:00:00Z', present: true }] })),
      store: vi.fn((r: { tokenId: number; harness: string }) => ok({ profileId: 'default', harness: r.harness, tokenId: r.tokenId, tokenName: 'dev', maskedKey: 'sk-ab**********yz', storedAt: '', present: true })),
      copy: vi.fn((r: { tokenId: number }) => ok({ copied: true as const, tokenId: r.tokenId, maskedKey: 'sk-ab**********yz' })),
      remove: vi.fn(() => ok({ removed: true })),
      show: vi.fn((r: { tokenId: number }) => ok({ shown: true, tokenId: r.tokenId, maskedKey: 'sk-ab**********yz' })),
    },
    app: {
      about: vi.fn(() => ok({
        productName: 'Portable Agent', version: '0.0.1', license: 'AGPL-3.0-only' as const,
        sourceUrl: 'https://github.com/example/portable-agent-client', sourceOffer: 'Source offer text', buildCommit: 'abc123',
        upstream: { name: 'new-api', author: 'QuantumNous', repo: 'https://github.com/QuantumNous/new-api', license: 'AGPL-3.0', tag: 'v1.0.0-rc.46', commit: '7d8b912' },
        attribution: 'Frontend design and development by New API contributors.',
        licenseFiles: [{ title: 'LICENSE (GNU AGPL-3.0)', path: '/licenses/LICENSE.txt' }],
      })),
    },
    server: {
      status: vi.fn(() => ok({
        serverUrl: cfg.serverUrl, insecureTransport: cfg.insecureTransport, clientVersion: '0.5.0',
        compat: { tag: 'v0.12.0-rc.46', minServer: '0.12.0', maxServerTested: '0.12.0-rc.46', policy: 'warn' },
        check: { verdict: 'ok', allowLogin: true, serverVersion: 'v0.12.0-rc.46', systemName: 'New API', insecureTransport: true, unsupported: [], turnstile: false, messages: [], checkedAt: Date.now() },
      })),
    },
    shop: { control: vi.fn(() => ok({ host: 'wzyp.cn' })) },
    onShopHost: vi.fn(() => () => {}),
    onSessionChanged: vi.fn(() => () => {}),
  }
  ;(window as unknown as { pa: unknown }).pa = fake
  return fake
}
export function removeFakePa() { delete (window as unknown as { pa?: unknown }).pa }
