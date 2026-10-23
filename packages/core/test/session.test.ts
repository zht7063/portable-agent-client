import { describe, expect, it } from 'vitest';
import { DefaultSessionManager, MemoryTokenStore, createCore, isInsecureServerUrl, normalizeServerUrl, toSk, redact } from '../src/index.js';

const stored = { serverUrl: 'http://x', refreshCookie: 'c1', userId: 3, username: 'u' };

describe('MemoryTokenStore', () => {
  it('save/load/clear and returns copies', async () => {
    const s = new MemoryTokenStore();
    expect(await s.load()).toBeNull();
    await s.save(stored);
    const got = await s.load();
    expect(got).toEqual(stored);
    got!.refreshCookie = 'mutated';
    expect((await s.load())!.refreshCookie).toBe('c1');
    await s.clear();
    expect(await s.load()).toBeNull();
  });
});

describe('DefaultSessionManager basics', () => {
  it('transitions and emits redacted views', async () => {
    const store = new MemoryTokenStore();
    const m = new DefaultSessionManager({ store, serverUrl: 'http://x' });
    const seen: string[] = [];
    m.onChange((v) => seen.push(v.status));
    expect(m.view().status).toBe('anonymous');
    await m.establish({ accessToken: 'jwt', accessExpiresAt: 100, stored });
    expect(m.view()).toEqual({ status: 'authenticated', userId: 3, username: 'u', accessExpiresAt: 100, storage: 'memory', serverUrl: 'http://x' });
    expect(JSON.stringify(m.view())).not.toContain('jwt');
    expect(JSON.stringify(m.view())).not.toContain('c1');
    expect(await m.getAccessToken()).toBe('jwt');
    const m2 = new DefaultSessionManager({ store, serverUrl: 'http://x' });
    expect((await m2.restore()).status).toBe('expired');
    await m.clear();
    expect(seen).toEqual(['authenticated', 'anonymous']);
    await expect(m.getAccessToken()).rejects.toMatchObject({ error: { code: 'UNAUTHORIZED' } });
  });
});

describe('core helpers and stubs', () => {
  it('helpers', () => {
    expect(toSk('abc')).toBe('sk-abc');
    expect(toSk('sk-abc')).toBe('sk-abc');
    expect(redact('Bearer sk-abcdefghijkl new_api_refresh=zzz;')).toBe('Bearer *** new_api_refresh=***;');
  });
  it('createCore requires a configured server (no built-in default); unauthenticated session call rejects', async () => {
    expect(() => createCore({ serverUrl: '', store: new MemoryTokenStore() })).toThrowError(/Invalid server URL/);
    const core = createCore({ serverUrl: 'http://new-api.test:3000/', store: new MemoryTokenStore(), fetch: async () => new Response('{}') });
    expect(core.http.baseUrl).toBe('http://new-api.test:3000');
    expect(core.http.insecure).toBe(true);
    await expect(core.http.api('GET', '/api/user/self')).rejects.toMatchObject({ error: { code: 'UNAUTHORIZED' } });
  });
  it('non-HTTPS servers are flagged (warn only), not rejected', () => {
    expect(isInsecureServerUrl(normalizeServerUrl('http://10.0.0.1:3000'))).toBe(true);
    expect(isInsecureServerUrl(normalizeServerUrl('https://api.example.com'))).toBe(false);
  });
});
