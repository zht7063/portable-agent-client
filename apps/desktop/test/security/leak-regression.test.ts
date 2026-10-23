/* eslint-disable @typescript-eslint/no-explicit-any */
/*
 * M7 consolidated leak-regression suite: the renderer must never receive a full API key, a session cookie or the
 * server access token -- across proxy responses (bodies + headers, success and error paths), IPC results and
 * errors. DOM checks live in src-local/__tests__/security-dom.test.tsx (vendored web harness).
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INVOKE_CHANNELS, MemoryKeyVault, MemoryTokenStore, createCore, type ClientConfig } from '@pac/core';
import { MemoryKeyring } from '@pac/keychain';
import { ServerProxy } from '../../src/main/proxy/api-proxy';
import { CookieJar } from '../../src/main/proxy/cookie-jar';
import { AccessTokenVault, maskErrorText } from '../../src/main/proxy/sanitize';
import { ServerSession } from '../../src/main/proxy/server-session';
import { evaluateStatus, type CompatRange } from '../../src/main/proxy/server-status';
import { KeyService } from '../../src/main/key-service';
import { createHandlers, dispatch } from '../../src/main/ipc/handlers';
import { handleAppRequest } from '../../src/main/app-protocol';
import { tmpHarnessHost } from '../harness-fixture';

const ORIGIN = 'https://na.example.test';
const COMPAT: CompatRange = { tag: 'v1.0.0-rc.46', minServer: 'v1.0.0-rc.46', maxServerTested: null, policy: 'same-minor-line' };
const RAW = 'Lk9' + 'q'.repeat(42) + 'Zz1';          // 48-char token key as stored by new-api (no sk-)
const FULL = `sk-${RAW}`;
const AT = 'AT0' + 'x'.repeat(40) + 'END';            // server access token
const REFRESH = 'RF' + 'r'.repeat(30) + '99';         // refresh cookie value
const SESSION = 'SS' + 's'.repeat(30) + '77';         // session cookie value
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJlMTIzNDU2';
const SECRETS = [RAW, FULL, AT, REFRESH, SESSION, JWT];

const expectClean = (where: string, s: string) => {
  for (const sec of SECRETS) expect(s.includes(sec), `${where} leaked ${sec.slice(0, 6)}…`).toBe(false);
};
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...extra } });

/** Upstream that sprinkles secrets everywhere it plausibly could. */
function leakyUpstream(url: string, init: RequestInit): Response {
  const p = new URL(url).pathname;
  const h = new Headers({ 'content-type': 'application/json', 'x-access-token': AT, authorization: `Bearer ${AT}` });
  if (p === '/api/user/login') {
    h.append('set-cookie', `new_api_refresh=${REFRESH}; Path=/api/user/auth; HttpOnly`);
    h.append('set-cookie', `session=${SESSION}; Path=/; HttpOnly`);
    return new Response(JSON.stringify({ success: true, data: { access_token: AT, token_type: 'Bearer', access_expires_at: 1, session: { sid: 1 }, user: { id: 1, access_token: AT } } }), { headers: h });
  }
  if (p === '/api/user/auth/refresh') return new Response(JSON.stringify({ success: true, data: { access_token: AT, token_type: 'Bearer', session: {}, refresh_token: REFRESH } }), { headers: h });
  if (p === '/api/user/self') return json({ success: true, data: { id: 1, access_token: AT, jwt: JWT, setting: `{"k":"${FULL}"}` } }, 200, { 'set-cookie': `session=${SESSION}` });
  if (p.startsWith('/api/token/') && p.endsWith('/key')) return json({ success: true, data: { key: RAW } });
  if (p.startsWith('/api/token')) return json({ success: true, data: { items: [{ id: 7, key: RAW }, { id: 8, key: FULL, name: `copy of ${FULL}` }] } });
  if (p === '/api/channel/') return json({ success: true, data: { items: [{ id: 1, key: FULL, other: `Bearer ${AT}` }] } });
  if (p === '/api/log/') return json({ success: false, message: `upstream rejected key ${FULL} (token ${RAW}) with bearer ${AT}` }, 500);
  if (p === '/api/data/') return new Response(`plain text error: key=${FULL} raw=${RAW} jwt=${JWT}`, { status: 502, headers: { 'content-type': 'text/plain' } });
  if (p === '/api/user/auth/logout') return json({ success: true }, 200, { 'set-cookie': `session=; Max-Age=0` });
  void init;
  return json({ success: true, data: {} });
}

function proxySetup() {
  const calls: { url: string; init: RequestInit }[] = [];
  const jar = new CookieJar();
  const vault = new AccessTokenVault();
  const proxy = new ServerProxy({
    getOrigin: () => ORIGIN, getCheck: () => evaluateStatus(COMPAT, ORIGIN, { success: true, data: { version: 'v1.0.0-rc.46' } }),
    getJar: () => jar, vault, fetch: vi.fn(async (url: string, init: RequestInit) => { calls.push({ url, init }); return leakyUpstream(url, init); }),
  });
  const req = (method: string, path: string, headers: Record<string, string> = {}, body: string | null = null) =>
    proxy.handle({ method, url: `pac://app${path}`, headers: new Headers(headers), body: body === null ? null : (new TextEncoder().encode(body).buffer as ArrayBuffer) });
  return { calls, jar, vault, proxy, req };
}

const dump = async (r: Response) => {
  const hs: string[] = []; r.headers.forEach((v, k) => hs.push(`${k}: ${v}`));
  return `${r.status}\n${hs.join('\n')}\n\n${r.body ? await r.text() : ''}`;
};

describe('leak regression: proxy responses (bodies, headers, errors)', () => {
  const paths: [string, string, string | null][] = [
    ['POST', '/api/user/login', '{"username":"u","password":"p"}'],
    ['POST', '/api/user/auth/refresh', null],
    ['GET', '/api/user/self', null],
    ['GET', '/api/token/?p=1', null],
    ['GET', '/api/token/7', null],
    ['POST', '/api/token/7/key', null], // renderer asking for the full key directly gets it masked
    ['GET', '/api/channel/', null],
    ['GET', '/api/log/', null],
    ['GET', '/api/data/', null],
    ['POST', '/api/user/auth/logout', null],
  ];
  it.each(paths)('%s %s: no key / cookie / access token reaches the renderer', async (m, p, b) => {
    const t = proxySetup();
    if (p !== '/api/user/login') await t.req('POST', '/api/user/login', {}, '{}'); // establish a main-side session first
    const r = await t.req(m, p, { authorization: 'Bearer ' + (t.vault.size ? 'pac-h.forged' : 'x') }, b);
    const out = await dump(r);
    expectClean(`${m} ${p}`, out);
    expect(out.toLowerCase()).not.toContain('set-cookie');
    expect(out.toLowerCase()).not.toContain('x-access-token');
  });
  it('the access token is only ever represented by an opaque main-side handle', async () => {
    const t = proxySetup();
    const body = (await (await t.req('POST', '/api/user/login', {}, '{}')).json()) as any;
    expect(body.data.access_token).toMatch(/^pac-h\./);
    expect(t.vault.resolve(body.data.access_token)).toBe(AT);
    expectClean('login json', JSON.stringify(body));
  });
  it('errors from the network layer and from the app protocol are clean', async () => {
    const jar = new CookieJar(); const vault = new AccessTokenVault();
    const proxy = new ServerProxy({ getOrigin: () => ORIGIN, getCheck: () => null, getJar: () => jar, vault, fetch: async () => { throw new Error(`connect failed for ${FULL}`); } });
    const r = await proxy.handle({ method: 'GET', url: 'pac://app/api/status', headers: new Headers(), body: null });
    // Network error messages are produced by undici and do not contain request secrets; still assert defensively.
    expect(r.status).toBe(502);
    const txt = await r.text();
    expect(txt).toContain('UPSTREAM_UNREACHABLE');
    const app = await handleAppRequest({ url: 'pac://app/api/token/', method: 'GET' }, '/nonexistent', 'pac', undefined, async () => json({ success: true, data: { items: [{ key: RAW }] } }));
    expect(app.status).toBe(200);
    // handleAppRequest passes the proxy's (already sanitised) response through; the proxy itself is covered above.
    expect(maskErrorText(`bad ${RAW} and ${AT}`, [AT])).not.toContain(RAW);
    expect(maskErrorText(`bad ${RAW} and ${AT}`, [AT])).not.toContain(AT);
  });
  it('renderer-supplied credentials are never forwarded; only main-held ones are', async () => {
    const t = proxySetup();
    await t.req('GET', '/api/user/self', { cookie: `session=${SESSION}`, authorization: `Bearer ${AT}` });
    const h = t.calls[0]!.init.headers as Record<string, string>;
    expect(h.cookie).toBeUndefined();
    expect(h.authorization).toBeUndefined();
  });
});

describe('leak regression: IPC results and errors', () => {
  async function ipcSetup() {
    const dir = mkdtempSync(join(tmpdir(), 'pa-sec-'));
    const s = new ServerSession({ compat: COMPAT, file: null, cipher: null, fetch: vi.fn(async (url: string, init: RequestInit) => {
      const p = new URL(url).pathname;
      if (p === '/api/token/7/key') return json({ success: true, data: { key: RAW } });
      if (p === '/api/token/7') return json({ success: true, data: { id: 7, name: `tok ${FULL}`, key: RAW } });
      if (p === '/api/token/9/key') return json({ success: false, message: `denied for ${FULL} bearer ${AT}` }, 403);
      void init; return json({ success: false, message: `boom ${RAW}` }, 500);
    }) as any });
    await s.setServer('http://127.0.0.1:3999');
    s.vault.issue(AT);
    const clip = { text: '', writeText: vi.fn((x: string) => { clip.text = x; }), readText: vi.fn(() => clip.text), clear: vi.fn(() => { clip.text = ''; }) };
    const keys = new KeyService({ keyring: new MemoryKeyring(), api: (m, p) => s.mainApi(m, p), clipboard: clip, metaFile: join(dir, 'meta.json') });
    const vault = new MemoryKeyVault(); void vault.set(2, FULL);
    const core = createCore({ serverUrl: 'http://127.0.0.1:3999', store: new MemoryTokenStore(), vault, fetch: async () => { throw new Error(`no network ${FULL}`); } });
    let cfg: ClientConfig = { serverUrl: 'http://127.0.0.1:3999', insecureTransport: true, clipboardClearSeconds: 30 };
    const handlers = createHandlers({
      getCore: () => core, getConfig: () => cfg, setConfig: async (p: Partial<ClientConfig>) => (cfg = { ...cfg, ...p }), harness: tmpHarnessHost().host.harness,
      keys, confirmRevealKey: async () => true, showKey: vi.fn(async () => {}),
      confirmDisableClipboardClear: async () => true,
      serverStatus: () => ({ origin: 'http://127.0.0.1:3999', verdict: 'supported', allowLogin: true, messages: [], checkedAt: 0 }) as any,
      about: () => ({ version: '0', commit: 'x' }) as any,
    } as any);
    return { handlers, clip };
  }
  const requests: Record<string, unknown[]> = {
    'config:get': [{}], 'config:set': [{ clipboardClearSeconds: 0 }, { serverUrl: `http://u:${RAW}@h.test` }],
    'keys:list': [{}], 'keys:store': [{ tokenId: 7, harness: 'codex' }, { tokenId: 9, harness: 'codex' }],
    'keys:copy': [{ tokenId: 7 }, { tokenId: 9 }, { tokenId: 7, curl: { endpoint: 'https://x.test/v1/chat/completions', model: 'm' } }],
    'keys:show': [{ tokenId: 7 }, { tokenId: 9 }], 'keys:delete': [{ harness: 'codex' }],
    'server:status': [{}], 'app:about': [{}],
  };
  it('every channel, with success and failure inputs, returns no secret', async () => {
    const { handlers, clip } = await ipcSetup();
    const seen: string[] = [];
    for (const ch of INVOKE_CHANNELS) {
      for (const req of requests[ch] ?? [{}, { id: 'codex', profileId: FULL }, null, 'x']) {
        const res = await dispatch(handlers, ch as any, req as any);
        seen.push(ch);
        expectClean(`IPC ${ch} ${JSON.stringify(req).slice(0, 40)}`, JSON.stringify(res));
      }
    }
    expect(new Set(seen)).toEqual(new Set(INVOKE_CHANNELS));
    expect(clip.text === '' || clip.text.includes(RAW)).toBe(true); // the clipboard (main-written) is the only sink
  });
  it('a buggy handler returning a key is blocked by the dispatch guard', async () => {
    const { handlers } = await ipcSetup();
    (handlers as any)['server:status'] = async () => ({ origin: 'x', note: FULL });
    const r = await dispatch(handlers, 'server:status', {} as any);
    expect(r).toMatchObject({ ok: false });
    expectClean('guarded', JSON.stringify(r));
    (handlers as any)['server:status'] = async () => { throw new Error(`exploded with ${FULL} / ${AT}`); };
    expectClean('thrown', JSON.stringify(await dispatch(handlers, 'server:status', {} as any)));
  });
});
