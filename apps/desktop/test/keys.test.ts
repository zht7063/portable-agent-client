/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryKeyVault, MemoryTokenStore, createCore, findCredentialLeaks } from '@pac/core';
import { MemoryKeyring, NoKeyring, type Keyring } from '@pac/keychain';
import { KeyService } from '../src/main/key-service';
import { createHandlers, dispatch } from '../src/main/ipc/handlers';
import { ServerProxy, MASKED_SAVE_MESSAGE, containsMaskedValue } from '../src/main/proxy/api-proxy';
import { ServerSession } from '../src/main/proxy/server-session';
import { CookieJar } from '../src/main/proxy/cookie-jar';
import { AccessTokenVault, maskSecret } from '../src/main/proxy/sanitize';
import { evaluateStatus, type CompatRange } from '../src/main/proxy/server-status';
import { tmpHarnessHost } from './harness-fixture';
import { HarnessHost } from '../src/main/harness-host';

const RAW = 'Zq' + '7'.repeat(44) + 'Xy'; // 48-char new-api token key (stored without sk-)
const FULL = `sk-${RAW}`;
const ORIGIN = 'http://127.0.0.1:3999';

function fakeServer() {
  const calls: { method: string; url: string; auth?: string }[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const h = init.headers as Record<string, string>;
    calls.push({ method: String(init.method), url, auth: h.authorization });
    if (h.authorization !== 'Bearer real-access-token') return new Response('{"success":false}', { status: 401 });
    const p = new URL(url).pathname;
    if (p === '/api/token/7/key' && init.method === 'POST') return Response.json({ success: true, data: { key: RAW } });
    if (p === '/api/token/7' && init.method === 'GET') return Response.json({ success: true, data: { id: 7, name: 'my-token', key: 'Zq77**********77Xy' } });
    return Response.json({ success: false, message: 'not found' }, { status: 404 });
  });
  return { calls, fetch };
}

async function session(fetch: any) {
  const s = new ServerSession({ compat: { tag: 'v1.0.0-rc.46', minServer: 'v1.0.0-rc.46', maxServerTested: null, policy: 'same-minor-line' } as CompatRange, fetch, file: null, cipher: null });
  await s.setServer(ORIGIN);
  return s;
}

function setup(keyring: Keyring = new MemoryKeyring()) {
  const dir = mkdtempSync(join(tmpdir(), 'pa-keys-'));
  const srv = fakeServer();
  const clip = { text: '', writeText: vi.fn((t: string) => { clip.text = t; }) };
  let s!: ServerSession;
  const ready = session(srv.fetch).then((x) => { s = x; s.vault.issue('real-access-token'); });
  const keys = new KeyService({ keyring, api: (m, p) => s.mainApi(m, p), clipboard: clip, metaFile: join(dir, 'keychain-entries.json'), now: () => new Date('2026-10-24T00:00:00Z') });
  return { dir, srv, clip, keys, keyring, ready, get s() { return s; } };
}

function allFiles(d: string): string[] {
  return readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? allFiles(p) : [p]; });
}

describe('M4 token -> keychain (main only)', () => {
  it('fetches the full key by token id via the main-only session and writes it to the keychain; returns masked metadata', async () => {
    const t = setup(); await t.ready;
    const info = await t.keys.store(7, 'claude');
    expect(await t.keyring.get('default/claude')).toBe(FULL);
    expect(info).toEqual({ profileId: 'default', harness: 'claude', tokenId: 7, tokenName: 'my-token', maskedKey: maskSecret(FULL), storedAt: '2026-10-24T00:00:00.000Z', present: true });
    expect(JSON.stringify(info)).not.toContain(RAW);
    expect(t.srv.calls[0]).toMatchObject({ method: 'POST', url: `${ORIGIN}/api/token/7/key`, auth: 'Bearer real-access-token' });
    for (const f of allFiles(t.dir)) expect(readFileSync(f, 'utf8')).not.toContain(RAW); // metadata file has no key
  });
  it('refuses without a session, with a bad id, a non-default profile, or an unavailable keychain (nothing stored)', async () => {
    const t = setup(); await t.ready;
    t.s.vault.clear();
    await expect(t.keys.store(7, 'claude')).rejects.toMatchObject({ error: { code: 'UNAUTHORIZED' } });
    t.s.vault.issue('real-access-token');
    await expect(t.keys.store(-1, 'claude')).rejects.toMatchObject({ error: { code: 'VALIDATION' } });
    await expect(t.keys.store(7, 'nope' as any)).rejects.toMatchObject({ error: { code: 'VALIDATION' } });
    await expect(t.keys.store(7, 'claude', 'work')).rejects.toMatchObject({ error: { code: 'VALIDATION' } });
    const n = setup(new NoKeyring('no D-Bus session')); await n.ready;
    await expect(n.keys.store(7, 'claude')).rejects.toMatchObject({ error: { code: 'VALIDATION', message: expect.stringContaining('env key mode') } });
    expect(n.srv.calls).toHaveLength(0); // key never fetched when it cannot be stored
    expect(await n.keys.list()).toMatchObject({ available: false, fallback: 'env', entries: [] });
  });
  it('IPC keys:* return only masked values/metadata; dispatch leak guard passes', async () => {
    const t = setup(); await t.ready;
    const { host } = tmpHarnessHost(t.keyring);
    const cfg = { serverUrl: ORIGIN, insecureTransport: true };
    const core = createCore({ serverUrl: ORIGIN, store: new MemoryTokenStore(), vault: new MemoryKeyVault(), fetch: async () => { throw new Error('no network'); } });
    const h = createHandlers({ getCore: () => core, getConfig: () => cfg, setConfig: async () => cfg, harness: host.harness, keys: t.keys });
    const results = [
      await dispatch(h, 'keys:store', { tokenId: 7, harness: 'codex' }),
      await dispatch(h, 'keys:list', {}),
      await dispatch(h, 'keys:copy', { tokenId: 7 }),
    ];
    for (const r of results) { expect(r.ok).toBe(true); expect(JSON.stringify(r)).not.toContain(RAW); expect(findCredentialLeaks(r)).toEqual([]); }
    expect(results[1]).toMatchObject({ ok: true, data: { available: true, backend: 'memory', entries: [{ harness: 'codex', tokenId: 7, tokenName: 'my-token', maskedKey: maskSecret(FULL), present: true }] } });
    expect(await dispatch(h, 'keys:delete', { harness: 'codex' })).toEqual({ ok: true, data: { removed: true } });
    expect(await t.keyring.get('default/codex')).toBeNull();
    const none = createHandlers({ getCore: () => core, getConfig: () => cfg, setConfig: async () => cfg, harness: host.harness });
    expect(await dispatch(none, 'keys:list', {})).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
  });
  it('a handler that leaked the key would be blocked by dispatch', async () => {
    const t = setup(); await t.ready;
    const leaky = { ...t.keys, list: t.keys.list.bind(t.keys), store: t.keys.store.bind(t.keys), remove: t.keys.remove.bind(t.keys), fetchKey: t.keys.fetchKey.bind(t.keys), copy: async () => ({ copied: true as const, tokenId: 7, maskedKey: FULL }) };
    const { host } = tmpHarnessHost(t.keyring);
    const cfg = { serverUrl: ORIGIN, insecureTransport: true };
    const h = createHandlers({ getCore: () => { throw new Error('x'); }, getConfig: () => cfg, setConfig: async () => cfg, harness: host.harness, keys: leaky });
    expect(await dispatch(h, 'keys:copy', { tokenId: 7 })).toMatchObject({ ok: false, error: { code: 'SERVER' } });
  });
  it('copy: main writes the full key to the clipboard; the response has the masked key only', async () => {
    const t = setup(); await t.ready;
    const r = await t.keys.copy(7);
    expect(t.clip.writeText).toHaveBeenCalledTimes(1);
    expect(t.clip.text).toBe(FULL);
    expect(r).toEqual({ copied: true, tokenId: 7, maskedKey: maskSecret(FULL) });
  });
  it('harness apply (command mode) provisions the keychain via the main session (ensure), once per token', async () => {
    const t = setup(); await t.ready;
    const root = mkdtempSync(join(tmpdir(), 'pa-keys-h-'));
    const home = join(root, 'home'); const dataDir = join(root, 'userData');
    const host = new HarnessHost({
      home, dataDir, env: { HOME: home }, platform: 'linux', keyring: t.keyring, helperPath: join(dataDir, 'bin', 'pa-key'),
      exec: async () => ({ code: null, stdout: '', stderr: 'not found' }), ensureKey: (p, h, id) => t.keys.ensure(p, h, id),
    });
    await host.harness.upsertProfile({ id: 'default', serverUrl: ORIGIN, keyId: 7, models: { main: 'm' }, keyMode: 'command' });
    const plan = await host.harness.plan('claude', 'default');
    const r = await host.harness.apply('claude', plan, []);
    expect(r.written).toEqual([join(home, '.claude', 'settings.json')]);
    expect(await t.keyring.get('default/claude')).toBe(FULL);
    const settings = readFileSync(join(home, '.claude', 'settings.json'), 'utf8');
    expect(settings).toContain('apiKeyHelper'); expect(settings).not.toContain(RAW);
    const fetched = t.srv.calls.filter((c) => c.url.endsWith('/key')).length;
    await t.keys.ensure('default', 'claude', 7);
    expect(t.srv.calls.filter((c) => c.url.endsWith('/key')).length).toBe(fetched); // already stored: no refetch
  });
});

describe('M4 masked admin form save is blocked in the proxy', () => {
  const COMPAT: CompatRange = { tag: 'v1.0.0-rc.46', minServer: 'v1.0.0-rc.46', maxServerTested: null, policy: 'same-minor-line' };
  function proxy() {
    const fetch = vi.fn(async () => Response.json({ success: true }));
    const p = new ServerProxy({ getOrigin: () => ORIGIN, getCheck: () => evaluateStatus(COMPAT, ORIGIN, { success: true, data: { version: 'v1.0.0-rc.46' } }), getJar: () => new CookieJar(), vault: new AccessTokenVault(), fetch });
    const req = (method: string, path: string, body: unknown) => p.handle({ method, url: `pac://app${path}`, headers: new Headers({ 'content-type': 'application/json' }), body: new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body)).buffer as ArrayBuffer });
    return { fetch, req };
  }
  it.each([
    ['PUT', '/api/channel/', { id: 1, name: 'c', key: maskSecret(FULL) }],
    ['POST', '/api/channel/', { name: 'c', key: 'ab****yz' }],
    ['PUT', '/api/option/', { key: 'SMTPToken', value: 'smtp**********word' }],
    ['PUT', '/api/option/', { key: 'GitHubClientSecret', value: maskSecret('0123456789abcdef0123') }],
    ['PUT', '/api/option/', { key: 'CustomOAuth', value: JSON.stringify({ client_secret: 'abcd**********wxyz' }) }],
    ['POST', '/api/custom-oauth-provider/', { name: 'x', client_secret: 'abcd**********wxyz' }],
  ])('%s %s with a masked value -> 409 with a "use the server web UI" message, not forwarded', async (m, path, body) => {
    const { fetch, req } = proxy();
    const res = await req(m, path, body);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ success: false, code: 'MASKED_SECRET_SAVE_BLOCKED', message: MASKED_SAVE_MESSAGE });
    expect(MASKED_SAVE_MESSAGE).toContain('server web UI');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('unmasked admin saves and non-admin bodies with stars pass through', async () => {
    const { fetch, req } = proxy();
    expect((await req('PUT', '/api/option/', { key: 'SMTPServer', value: 'smtp.example.test' })).status).toBe(200);
    expect((await req('PUT', '/api/option/', { key: 'CorsOrigins', value: '*' })).status).toBe(200);
    expect((await req('PUT', '/api/channel/', { id: 1, key: '' })).status).toBe(200);
    expect((await req('POST', '/api/token/', { name: 'a**********b' })).status).toBe(200); // not an admin secret endpoint
    expect(fetch).toHaveBeenCalledTimes(4);
  });
  it('detector', () => {
    expect(containsMaskedValue(new TextEncoder().encode('{"a":["x","pac-h.abc"]}').buffer as ArrayBuffer)).toBe(true);
    expect(containsMaskedValue(new TextEncoder().encode('{"a":"plain"}').buffer as ArrayBuffer)).toBe(false);
    expect(containsMaskedValue(new TextEncoder().encode('k=abcd**********wxyz').buffer as ArrayBuffer)).toBe(true);
  });
});
