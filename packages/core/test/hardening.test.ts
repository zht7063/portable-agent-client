import { describe, expect, it } from 'vitest';
import { MemoryKeyVault, MemoryTokenStore, PaException, createCore, redact, toPaError } from '../src/index.js';
import { json, loginData, mockFetch, ok, refreshCookie } from './mock-http.js';

const T0 = 1_792_747_624;
const stored = { serverUrl: 'http://srv', refreshCookie: 'c1', userId: 3, username: 'tester' };

function setup(routes: Parameters<typeof mockFetch>[0], extra: Record<string, unknown> = {}) {
  const m = mockFetch(routes);
  const store = new MemoryTokenStore();
  const vault = new MemoryKeyVault();
  const t = { t: T0 };
  const core = createCore({ serverUrl: 'http://srv', store, vault, fetch: m.fetch, clock: { now: () => t.t * 1000 }, ...extra });
  return { ...m, store, vault, core, t };
}
const refreshOk = () => ok(loginData('jwt-2', T0 + 900), { cookies: [refreshCookie('c2')] });

describe('refresh failure policy: only 401/403 log the user out', () => {
  it.each([
    ['500', () => new Response('boom', { status: 500 }), 'SERVER'],
    ['502', () => new Response('bad gateway', { status: 502 }), 'SERVER'],
    ['503 json', () => json({ success: false, message: 'maintenance' }, { status: 503 }), 'SERVER'],
    ['429', () => new Response('slow', { status: 429, headers: { 'retry-after': '5' } }), 'RATE_LIMITED'],
    ['network', () => { throw new TypeError('fetch failed'); }, 'NETWORK'],
    ['200 success:false', () => json({ success: false, message: 'temporary' }), 'VALIDATION'],
  ] as const)('%s keeps the session and surfaces the error', async (_n, h, code) => {
    const { core, store } = setup({ 'POST /api/user/auth/refresh': [h as () => Response, h as () => Response, refreshOk] });
    await store.save(stored);
    const v = await core.session.restore();
    expect(v.status).toBe('authenticated');
    expect(v.username).toBe('tester');
    expect(await store.load()).toEqual(stored);
    // API calls report the transient error, not "logged out".
    await expect(core.session.getAccessToken()).rejects.toMatchObject({ error: { code } });
    // Recovers on the next successful refresh.
    expect(await core.session.refresh()).toBe(true);
    expect(core.session.view().status).toBe('authenticated');
    expect(await core.session.getAccessToken()).toBe('jwt-2');
  });

  it('a failed refresh reports the transient error (not SESSION_EXPIRED)', async () => {
    const { core, store } = setup({ 'POST /api/user/auth/refresh': () => new Response('x', { status: 500 }) });
    await store.save(stored);
    await core.session.restore();
    expect(await core.session.refresh()).toBe(false);
    expect(core.session.transientError()).toMatchObject({ code: 'SERVER' });
    expect(core.session.view().status).toBe('authenticated');
  });

  it.each([401, 403])('%i clears the session', async (status) => {
    const { core, store } = setup({ 'POST /api/user/auth/refresh': () => json({ success: false, message: 'invalid session' }, { status }) });
    await store.save(stored);
    expect((await core.session.restore()).status).toBe('anonymous');
    expect(await store.load()).toBeNull();
    expect(await core.session.refresh()).toBe(false);
    expect(core.session.transientError()).toBeNull();
  });

  it('API 401 followed by a 5xx refresh fails the call but keeps the session', async () => {
    const { core, store } = setup({
      'GET /api/user/self': () => new Response('{}', { status: 401 }),
      'POST /api/user/auth/refresh': () => new Response('down', { status: 503 }),
    });
    await core.session.establish({ accessToken: 'jwt-1', accessExpiresAt: T0 + 900, stored });
    await expect(core.http.api('GET', '/api/user/self')).rejects.toMatchObject({ error: { code: 'SERVER' } });
    expect(core.session.view().status).toBe('authenticated');
    expect(await store.load()).not.toBeNull();
  });
});

describe('redaction', () => {
  const secrets = [
    'sk-' + 'A1b2C3d4'.repeat(6), 'nap_' + 'x9'.repeat(16),
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl', 'new_api_refresh=Zm9vYmFyYmF6',
    'http://203.0.113.7:3000/api/user/self', 'https://api.example.com/v1/chat', '203.0.113.7', 'example.com:8443',
  ];
  it('strips tokens, cookies, URLs and hosts', () => {
    const msg = `fail ${secrets.join(' ; ')} Authorization: Bearer abc.def Cookie: a=b; c=d getaddrinfo ENOTFOUND relay.internal`;
    const out = redact(msg);
    for (const s of [...secrets, 'abc.def', 'a=b', 'relay.internal', '113.7:3000']) expect(out).not.toContain(s);
    expect(out).toContain('sk-***');
    expect(out).toContain('<url>');
    expect(redact('Username must be 1-20 characters')).toBe('Username must be 1-20 characters');
    expect(redact('用户名已存在')).toBe('用户名已存在');
  });
  it('toPaError always redacts messages', () => {
    const e = new PaException({ code: 'SERVER', message: `upstream http://10.0.0.5:8080 rejected sk-${'z'.repeat(40)}`, status: 502 });
    const p = toPaError(e);
    expect(p).toMatchObject({ code: 'SERVER', status: 502 });
    expect(p.message).not.toMatch(/10\.0\.0\.5|zzzz|http:/);
  });
  it('server error messages are redacted before reaching callers', async () => {
    const { core } = setup({ 'POST /api/user/login': () => json({ success: false, message: 'dial tcp 172.17.0.2:5432: connection refused' }, { status: 500 }) });
    const err = await core.http.api('POST', '/api/user/login', { auth: 'none', body: {} }).then(() => { throw new Error('expected failure'); }, (e: unknown) => toPaError(e));
    expect(err.message).not.toContain('172.17.0.2');
  });
});

describe('http origin pinning (no credentials to other hosts)', () => {
  it.each(['https://evil.example/x', '//evil.example/x', 'api/user', '/\\evil.example', '/a b'])('refuses path %s', async (path) => {
    const { core, calls } = setup({});
    await expect(core.http.api('GET', path, { auth: 'none' })).rejects.toMatchObject({ error: { code: 'VALIDATION' } });
    expect(calls).toHaveLength(0);
  });
  it('never follows redirects (manual) and refuses 3xx responses', async () => {
    let init: RequestInit | undefined;
    const core = createCore({ serverUrl: 'http://srv', store: new MemoryTokenStore(), fetch: async (_u, i) => { init = i; return new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }); } });
    await expect(core.http.api('GET', '/api/status', { auth: 'none' })).rejects.toMatchObject({ error: { code: 'SERVER', message: 'Server redirect refused' } });
    expect(init?.redirect).toBe('manual');
  });
});
