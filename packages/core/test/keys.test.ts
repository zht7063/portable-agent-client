import { describe, expect, it } from 'vitest';
import { MemoryKeyVault, MemoryTokenStore, createCore } from '../src/index.js';
import { mockFetch, ok } from './mock-http.js';

const FULL = 'A'.repeat(48);
const stored = { serverUrl: 'http://srv', refreshCookie: 'c', userId: 3, username: 'tester' };

async function setup(routes: Parameters<typeof mockFetch>[0]) {
  const m = mockFetch(routes);
  const vault = new MemoryKeyVault();
  const core = createCore({ serverUrl: 'http://srv', store: new MemoryTokenStore(), vault, fetch: m.fetch });
  await core.session.establish({ accessToken: 'jwt', accessExpiresAt: 9_999_999_999, stored });
  return { core, calls: m.calls, vault };
}

describe('keys (token -> keychain orchestration only)', () => {
  it('secret: POST /api/token/:id/key once, sk- prefixed, then served from the vault', async () => {
    const { core, calls, vault } = await setup({ 'POST /api/token/2/key': () => ok({ key: FULL }) });
    expect(await core.keys.secret(2)).toBe(`sk-${FULL}`);
    expect(await core.keys.secret(2)).toBe(`sk-${FULL}`);
    expect(calls.filter((c) => c.path === '/api/token/2/key')).toHaveLength(1);
    expect(calls[0]!.headers.authorization).toBe('Bearer jwt');
    expect(await vault.get(2)).toBe(`sk-${FULL}`);
    await core.keys.forget(2);
    expect(await vault.has(2)).toBe(false);
  });

  it('keeps an existing sk- prefix; rejects empty server answers and invalid ids', async () => {
    const { core } = await setup({ 'POST /api/token/3/key': () => ok({ key: `sk-${FULL}` }), 'POST /api/token/4/key': () => ok({}) });
    expect(await core.keys.secret(3)).toBe(`sk-${FULL}`);
    await expect(core.keys.secret(4)).rejects.toMatchObject({ error: { code: 'SERVER' } });
    for (const id of [0, -1, 1.5, Number.NaN]) await expect(core.keys.secret(id)).rejects.toMatchObject({ error: { code: 'VALIDATION' } });
  });

  it('server errors are redacted and never echo the key', async () => {
    const { core } = await setup({ 'POST /api/token/5/key': () => new Response(JSON.stringify({ success: false, message: `bad sk-${FULL}` }), { status: 429 }) });
    const e = (await core.keys.secret(5).then(() => { throw new Error('expected failure'); }, (x: unknown) => x)) as { error: { code: string; message: string } };
    expect(e.error.code).toBe('RATE_LIMITED');
    expect(e.error.message).not.toContain(FULL);
  });
});
