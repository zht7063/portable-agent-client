/**
 * M3 live integration: the main-process proxy against a LOCAL, throwaway new-api server (official v1.0.0-rc.46
 * build) with a fake test account. Never point this at a real deployment.
 * Enable: PAC_LIVE_PROXY=1 PAC_SERVER_URL=http://127.0.0.1:PORT PAC_LIVE_USER=... PAC_LIVE_PASS_FILE=/path [PAC_LIVE_KEY_OUT=/path]
 * Secrets are read from files and never printed.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { ServerProxy } from '../../apps/desktop/src/main/proxy/api-proxy';
import { CookieJar } from '../../apps/desktop/src/main/proxy/cookie-jar';
import { AccessTokenVault, HANDLE_PREFIX } from '../../apps/desktop/src/main/proxy/sanitize';
import { checkServer, type CompatRange, type ServerCheck } from '../../apps/desktop/src/main/proxy/server-status';

const live = process.env.PAC_LIVE_PROXY === '1' && !!process.env.PAC_SERVER_URL && !!process.env.PAC_LIVE_PASS_FILE;
const compat = JSON.parse(readFileSync(new URL('../../compat.json', import.meta.url), 'utf8')) as CompatRange;

describe.skipIf(!live)('live: main proxy + login A against local new-api', () => {
  const origin = new URL(process.env.PAC_SERVER_URL ?? 'http://x').origin;
  const jar = new CookieJar();
  const vault = new AccessTokenVault();
  const realTokens: string[] = [];
  const issue = vault.issue.bind(vault);
  vault.issue = (t: string) => { realTokens.push(t); return issue(t); };
  let check: ServerCheck | null = null;
  const proxy = new ServerProxy({ getOrigin: () => origin, getCheck: () => check, getJar: () => jar, vault, fetch: (u, i) => fetch(u, i) });
  const bodies: string[] = [];
  let handle = '';
  let sid = '';
  const call = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
    const headers = new Headers({ 'content-type': 'application/json', ...extra });
    if (handle) headers.set('authorization', `Bearer ${handle}`);
    const res = await proxy.handle({ method, url: `pac://app${path}`, headers, body: body === undefined ? null : new TextEncoder().encode(JSON.stringify(body)).buffer as ArrayBuffer });
    expect(res.headers.get('set-cookie')).toBeNull();
    const text = await res.text();
    bodies.push(text);
    return { status: res.status, json: JSON.parse(text) as { success: boolean; data: any; message?: string } }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };

  it('public /api/status check: in range, no credentials', async () => {
    check = await checkServer(compat, origin, (u, i) => fetch(u, i));
    expect(check.verdict).toBe('ok');
    expect(check.serverVersion).toBe(compat.tag);
    expect(check.insecureTransport).toBe(origin.startsWith('http://'));
    expect(check.allowLogin).toBe(true);
  });

  it('logs in through the proxy; renderer gets a handle, main keeps cookies', async () => {
    const r = await call('POST', '/api/user/login', { username: process.env.PAC_LIVE_USER, password: readFileSync(process.env.PAC_LIVE_PASS_FILE!, 'utf8').trim() });
    expect(r.json.success).toBe(true);
    handle = r.json.data.access_token;
    sid = r.json.data.session.sid;
    expect(handle.startsWith(HANDLE_PREFIX)).toBe(true);
    expect(realTokens.length).toBe(1);
    expect(jar.all().map((c) => c.name).sort()).toEqual(expect.arrayContaining(['new_api_has_session']));
    expect(jar.size).toBeGreaterThanOrEqual(2);
    const self = await call('GET', '/api/user/self');
    expect(self.json.success).toBe(true);
    expect(self.json.data.username).toBe(process.env.PAC_LIVE_USER);
  });

  it('token list and key reveal are masked', async () => {
    const created = await call('POST', '/api/token/', { name: 'pac-live', remain_quota: 0, unlimited_quota: true, expired_time: -1 });
    expect(created.json.success).toBe(true);
    const list = await call('GET', '/api/token/?p=1&size=10');
    const item = list.json.data.items.find((t: { name: string }) => t.name === 'pac-live');
    expect(item.key).toContain('**********');
    const reveal = await call('POST', `/api/token/${item.id}/key`);
    expect(JSON.stringify(reveal.json)).toContain('**********');
    // Ground truth straight from the server (test-only, bypassing the proxy) to prove the full key never passed.
    const raw = await fetch(`${origin}/api/token/${item.id}/key`, { method: 'POST', headers: { authorization: `Bearer ${realTokens.at(-1)}` } });
    const full = ((await raw.json()) as { data: { key: string } }).data.key;
    expect(full.length).toBeGreaterThan(20);
    if (process.env.PAC_LIVE_KEY_OUT) writeFileSync(process.env.PAC_LIVE_KEY_OUT, full, { mode: 0o600 });
    if (process.env.PAC_LIVE_TOKEN_ID_OUT) writeFileSync(process.env.PAC_LIVE_TOKEN_ID_OUT, String(item.id));
    for (const b of bodies) expect(b.includes(full)).toBe(false);
  });

  it('refresh via main-only cookie rotates the handle; logout clears the main session', async () => {
    const before = handle;
    const r = await call('POST', '/api/user/auth/refresh', undefined, { 'x-auth-session': sid });
    expect(r.json.success).toBe(true);
    handle = r.json.data.access_token;
    expect(handle.startsWith(HANDLE_PREFIX) && handle !== before).toBe(true);
    expect((await call('GET', '/api/user/self')).json.success).toBe(true);
    for (const b of bodies) for (const t of realTokens) expect(b.includes(t)).toBe(false);
    for (const b of bodies) for (const c of jar.all()) if (c.value.length >= 8) expect(b.includes(c.value)).toBe(false);
    await call('POST', '/api/user/auth/logout');
    expect(jar.size).toBe(0);
    expect(vault.size).toBe(0);
  });

  it('login is blocked when the check fails (simulated too-old server)', async () => {
    check = { ...check!, verdict: 'too-old', allowLogin: false, messages: ['too old'] };
    const r = await call('POST', '/api/user/login', { username: 'x', password: 'y' });
    expect(r.status).toBe(403);
    expect(r.json.message).toBe('too old');
  });
});
