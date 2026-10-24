/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest';
import { decide, normalisePath } from '../src/main/proxy/allowlist';
import { CookieJar, parseSetCookie, pathMatch } from '../src/main/proxy/cookie-jar';
import { AccessTokenVault, HANDLE_PREFIX, filterRequestHeaders, filterResponseHeaders, maskSecret, sanitizeJson } from '../src/main/proxy/sanitize';
import { ServerProxy, LIMITS, rewriteStatus } from '../src/main/proxy/api-proxy';
import { checkServer, classify, evaluateStatus, type CompatRange, type ServerCheck } from '../src/main/proxy/server-status';
import { handleAppRequest } from '../src/main/app-protocol';

const ORIGIN = 'https://na.example.test';
const KEY48 = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKl';
const COMPAT: CompatRange = { tag: 'v1.0.0-rc.46', minServer: 'v1.0.0-rc.46', maxServerTested: null, policy: 'same-minor-line' };
const okCheck = (): ServerCheck => evaluateStatus(COMPAT, ORIGIN, { success: true, data: { version: 'v1.0.0-rc.46' } });

function setup(opts: { check?: ServerCheck | null; origin?: string | null; respond?: (url: string, init: RequestInit) => Response } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return opts.respond ? opts.respond(url, init) : new Response('{"success":true}', { headers: { 'content-type': 'application/json' } });
  });
  const jar = new CookieJar();
  const vault = new AccessTokenVault();
  const proxy = new ServerProxy({
    getOrigin: () => (opts.origin === undefined ? ORIGIN : opts.origin), getCheck: () => (opts.check === undefined ? okCheck() : opts.check),
    getJar: () => jar, vault, fetch,
  });
  const req = (method: string, path: string, headers: Record<string, string> = {}, body: string | null = null) =>
    proxy.handle({ method, url: `pac://app${path}`, headers: new Headers(headers), body: body === null ? null : new TextEncoder().encode(body).buffer as ArrayBuffer });
  return { calls, fetch, jar, vault, proxy, req };
}
const sentHeaders = (init: RequestInit) => init.headers as Record<string, string>;

describe('allowlist', () => {
  it('allows upstream frontend endpoints with the right methods', () => {
    expect(decide('GET', '/api/status')).toEqual({ allow: true });
    expect(decide('POST', '/api/user/login')).toEqual({ allow: true });
    expect(decide('GET', '/api/token/')).toEqual({ allow: true });
    expect(decide('DELETE', '/api/token/3')).toEqual({ allow: true });
    expect(decide('POST', '/pg/chat/completions')).toEqual({ allow: true });
    expect(decide('POST', '/api/oauth/email/bind')).toEqual({ allow: true });
  });
  it('rejects wrong methods on read-only endpoints', () => {
    expect(decide('POST', '/api/status')).toMatchObject({ allow: false, status: 405 });
    expect(decide('OPTIONS', '/api/user/self')).toMatchObject({ allow: false, status: 405 });
    expect(decide('TRACE', '/api/token/')).toMatchObject({ allow: false });
    expect(decide('GET', '/pg/chat/completions')).toMatchObject({ allow: false, status: 405 });
  });
  it('denies unknown paths, relay keys paths, webhooks, OAuth and passkey login', () => {
    for (const p of ['/api/unknown', '/v1/chat/completions', '/mj/submit/imagine', '/api/stripe/webhook', '/api/creem/webhook', '/api/subscription/epay/notify', '/api/user/epay/notify'])
      expect(decide('POST', p).allow).toBe(false);
    expect(decide('GET', '/api/oauth/github')).toMatchObject({ allow: false, code: 'OAUTH_UNSUPPORTED' });
    expect(decide('POST', '/api/oauth/state')).toMatchObject({ allow: false, code: 'OAUTH_UNSUPPORTED' });
    expect(decide('POST', '/api/user/login/passkey/begin')).toMatchObject({ allow: false, code: 'PASSKEY_UNSUPPORTED' });
    expect(decide('GET', '/apix/status').allow).toBe(false);
  });
  it('normalisePath rejects traversal and encoded separators', () => {
    for (const p of ['/api/../v1/x', '/api/%2e%2e/x', '/api%2fuser', '/api\\user', '//evil.test/api/status', '/api/./status', 'api/status', '/api/%00'])
      expect(normalisePath(p)).toBeNull();
    expect(normalisePath('/api/user/self')).toBe('/api/user/self');
  });
});

describe('cookie jar (main-only)', () => {
  it('parses Set-Cookie with path/max-age and matches paths', () => {
    const c = parseSetCookie('rt=abc; Path=/api/user/auth; Max-Age=60; HttpOnly; SameSite=Strict', '/api/user/login', 1000);
    expect(c).toEqual({ name: 'rt', value: 'abc', path: '/api/user/auth', expires: 61000, secure: false });
    expect(pathMatch('/api/user/auth/refresh', '/api/user/auth')).toBe(true);
    expect(pathMatch('/api/user/authx', '/api/user/auth')).toBe(false);
  });
  it('scopes cookies by path, honours deletion and Secure', () => {
    const changes: number[] = [];
    const j = new CookieJar((all) => changes.push(all.length));
    j.store(['rt=r1; Path=/api/user/auth', 'hint=1; Path=/', 's=x; Path=/; Secure'], '/api/user/login');
    expect(j.header('/api/user/auth/refresh', false)).toBe('rt=r1; hint=1');
    expect(j.header('/api/user/self', false)).toBe('hint=1');
    expect(j.header('/api/user/self', true)).toBe('hint=1; s=x');
    j.store(['rt=; Path=/api/user/auth; Max-Age=0'], '/api/user/auth/logout');
    expect(j.header('/api/user/auth/refresh', false)).toBe('hint=1');
    expect(changes.length).toBe(2);
  });
});

describe('masking', () => {
  it('replaces the access token of an auth bundle with an opaque handle kept in main', () => {
    const vault = new AccessTokenVault();
    const out = sanitizeJson({ success: true, data: { access_token: 'real-access-token-xyz', token_type: 'Bearer', access_expires_at: 9, session: { sid: 's1' }, user: { id: 1 } } }, vault) as { data: { access_token: string; session: unknown } };
    expect(out.data.access_token.startsWith(HANDLE_PREFIX)).toBe(true);
    expect(JSON.stringify(out)).not.toContain('real-access-token-xyz');
    expect(vault.resolve(out.data.access_token)).toBe('real-access-token-xyz');
    expect(out.data.session).toEqual({ sid: 's1' });
  });
  it('masks token-list keys, sk- keys anywhere, secret fields, otpauth and JWTs; keeps option keys', () => {
    const vault = new AccessTokenVault();
    const body = {
      data: {
        items: [{ id: 1, name: 't', key: KEY48 }, { id: 2, key: `sk-${KEY48}` }],
        note: `use sk-${KEY48} please`,
        options: [{ key: 'SMTPServer', value: 'smtp.example' }, { key: 'GitHubClientSecret', value: '' }],
        secret: 'JBSWY3DPEHPK3PXP', qr_code_data: 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP', backup_codes: ['aaaa-bbbb', 'cccc-dddd'],
        refresh_token: 'rrrrrrrrrrrr', client_secret: 'cs-123456789', password: 'hunter2hunter2',
        jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk',
        access_token: 'lone-access-token-without-bundle',
      },
    };
    const out = JSON.stringify(sanitizeJson(body, vault));
    for (const s of [KEY48, 'JBSWY3DPEHPK3PXP', 'aaaa-bbbb', 'rrrrrrrrrrrr', 'cs-123456789', 'hunter2hunter2', 'eyJhbGciOiJIUzI1NiJ9', 'lone-access-token-without-bundle'])
      expect(out).not.toContain(s);
    expect(out).toContain(maskSecret(KEY48));
    expect(out).toContain('"key":"SMTPServer"');
    expect(out).toContain('"key":"GitHubClientSecret"');
    expect(vault.size).toBe(0);
  });
  it('maskSecret matches upstream MaskTokenKey shape', () => {
    expect(maskSecret('abcd')).toBe('****');
    expect(maskSecret('abcdefgh')).toBe('ab****gh');
    expect(maskSecret(KEY48)).toBe('AbCd**********GhIjKl'.replace('GhIjKl', 'IjKl'));
  });
  it('header filters drop cookies, auth, host/origin and server internals', () => {
    const req = filterRequestHeaders(new Headers({ cookie: 'a=b', authorization: 'Bearer x', origin: 'pac://app', host: 'h', 'content-type': 'application/json', 'x-auth-session': 's', 'new-api-user': '1' }));
    expect(req).toEqual({ 'content-type': 'application/json', 'x-auth-session': 's' });
    const h = new Headers({ 'content-type': 'application/json', server: 'gin', 'x-new-api-version': 'v' });
    h.append('set-cookie', 'a=b');
    expect(filterResponseHeaders(h)).toEqual({ 'content-type': 'application/json' });
  });
});

describe('ServerProxy', () => {
  it('pins the origin and forwards only allowlisted requests', async () => {
    const t = setup();
    expect((await t.req('GET', '/api/status?x=1')).status).toBe(200);
    expect(t.calls[0]!.url).toBe(`${ORIGIN}/api/status?x=1`);
    expect(t.calls[0]!.init.redirect).toBe('manual');
    expect((await t.req('GET', '/v1/models')).status).toBe(403);
    expect((await t.req('GET', '//evil.test/api/status')).status).toBe(400);
    expect(t.calls.length).toBe(1);
  });
  it('503 without a configured server, no network', async () => {
    const t = setup({ origin: null });
    const r = await t.req('GET', '/api/status');
    expect(r.status).toBe(503);
    expect(((await r.json()) as any).code).toBe('NO_SERVER');
    expect(t.fetch).not.toHaveBeenCalled();
  });
  it('captures Set-Cookie into the main jar, strips it from the response and attaches Cookie itself', async () => {
    const t = setup({
      respond: (url) => {
        const h = new Headers({ 'content-type': 'application/json' });
        if (url.endsWith('/api/user/login')) { h.append('set-cookie', 'new_api_refresh=R123456789; Path=/api/user/auth; HttpOnly'); h.append('set-cookie', 'new_api_has_session=1; Path=/'); }
        return new Response(JSON.stringify({ success: true, data: url.endsWith('/login') ? { access_token: 'AT-REAL-1', token_type: 'Bearer', access_expires_at: 1, session: { sid: 'x' }, user: { id: 1 } } : {} }), { headers: h });
      },
    });
    const login = await t.req('POST', '/api/user/login', { 'content-type': 'application/json', cookie: 'renderer=1' }, '{"username":"u"}');
    expect(login.headers.get('set-cookie')).toBeNull();
    const body = (await login.json()) as any;
    expect(JSON.stringify(body)).not.toContain('AT-REAL-1');
    expect(sentHeaders(t.calls[0]!.init).cookie).toBeUndefined(); // renderer cookie header ignored
    // Next request: handle -> real bearer; jar cookie for matching path only.
    await t.req('POST', '/api/user/auth/refresh', { authorization: `Bearer ${body.data.access_token}` });
    expect(sentHeaders(t.calls[1]!.init).authorization).toBe('Bearer AT-REAL-1');
    expect(sentHeaders(t.calls[1]!.init).cookie).toBe('new_api_refresh=R123456789; new_api_has_session=1');
    await t.req('GET', '/api/user/self', { authorization: 'Bearer forged-token' });
    expect(sentHeaders(t.calls[2]!.init).authorization).toBeUndefined();
    expect(sentHeaders(t.calls[2]!.init).cookie).toBe('new_api_has_session=1');
  });
  it('clears main session on logout', async () => {
    const t = setup();
    t.jar.store(['a=b; Path=/'], '/');
    t.vault.issue('x');
    await t.req('POST', '/api/user/auth/logout');
    expect(t.jar.size).toBe(0);
    expect(t.vault.size).toBe(0);
  });
  it('never follows redirects; cross-origin redirects are blocked, same-origin rewritten to a path', async () => {
    const cross = setup({ respond: () => new Response(null, { status: 302, headers: { location: 'https://evil.test/x' } }) });
    const r1 = await cross.req('GET', '/api/user/self');
    expect(r1.status).toBe(502);
    expect(((await r1.json()) as any).code).toBe('CROSS_ORIGIN_REDIRECT');
    const same = setup({ respond: () => new Response(null, { status: 302, headers: { location: `${ORIGIN}/api/status?a=1` } }) });
    const r2 = await same.req('GET', '/api/user/self');
    expect(r2.status).toBe(302);
    expect(r2.headers.get('location')).toBe('/api/status?a=1');
    expect(same.calls.length).toBe(1);
  });
  it('blocks login when the server check forbids it, with the reason', async () => {
    const tooOld = evaluateStatus(COMPAT, ORIGIN, { success: true, data: { version: 'v0.9.0' } });
    const t = setup({ check: tooOld });
    const r = await t.req('POST', '/api/user/login', {}, '{}');
    expect(r.status).toBe(403);
    expect(((await r.json()) as any).message).toContain('低于');
    expect(t.fetch).not.toHaveBeenCalled();
    expect((await setup({ check: null }).req('POST', '/api/user/login', {}, '{}')).status).toBe(403);
    expect((await t.req('GET', '/api/status')).status).toBe(200); // non-login traffic still flows
  });
  it('enforces size limits', async () => {
    const t = setup();
    const big = new ArrayBuffer(LIMITS.requestBody + 1);
    const r = await t.proxy.handle({ method: 'POST', url: 'pac://app/api/token/', headers: new Headers(), body: big });
    expect(r.status).toBe(413);
    const huge = setup({ respond: () => new Response(new Uint8Array(LIMITS.responseBody + 1), { headers: { 'content-type': 'application/octet-stream' } }) });
    expect((await huge.req('GET', '/api/data/')).status).toBe(502);
  });
  it('masks keys in token list responses and hides unsupported login methods in /api/status', async () => {
    const t = setup({
      respond: (url) => new Response(JSON.stringify(url.includes('/api/status')
        ? { success: true, data: { version: 'v1.0.0-rc.46', github_oauth: true, passkey_login: true, custom_oauth_providers: [{ id: 1 }], turnstile_check: false } }
        : { success: true, data: { items: [{ id: 1, key: KEY48 }] } }), { headers: { 'content-type': 'application/json' } }),
    });
    const list = await (await t.req('GET', '/api/token/?p=1')).text();
    expect(list).not.toContain(KEY48);
    expect(list).toContain('**********');
    const st = (await (await t.req('GET', '/api/status')).json()) as any;
    expect(st.data).toMatchObject({ github_oauth: false, passkey_login: false, custom_oauth_providers: [] });
    expect(rewriteStatus(null)).toBeNull();
  });
});

describe('server version check', () => {
  it('classifies versions against compat.json', () => {
    expect(classify(COMPAT, 'v1.0.0-rc.46')).toBe('ok');
    expect(classify(COMPAT, 'v1.0.0-rc.47')).toBe('untested');
    expect(classify(COMPAT, 'v1.0.0')).toBe('untested');
    expect(classify(COMPAT, 'v1.0.7')).toBe('untested');
    expect(classify(COMPAT, 'v1.1.0')).toBe('incompatible');
    expect(classify(COMPAT, 'v2.0.0')).toBe('incompatible');
    expect(classify({ ...COMPAT, policy: 'exact' }, 'v1.0.0-rc.47')).toBe('incompatible');
    expect(classify({ ...COMPAT, policy: 'exact' }, 'v1.0.0-rc.46')).toBe('ok');
    const blocked = evaluateStatus(COMPAT, 'https://x.test', { success: true, data: { version: 'v1.1.0' } });
    expect(blocked).toMatchObject({ verdict: 'incompatible', allowLogin: false });
    expect(blocked.messages[0]).toContain('v1.0.x');
    expect(classify(COMPAT, 'v1.0.0-rc.45')).toBe('too-old');
    expect(classify(COMPAT, 'v0.9.9')).toBe('too-old');
    expect(classify(COMPAT, 'one-api v0.6')).toBe('not-new-api');
    expect(classify(COMPAT, undefined)).toBe('not-new-api');
    expect(classify({ ...COMPAT, maxServerTested: 'v1.0.0-rc.50' }, 'v1.0.0-rc.50')).toBe('ok');
  });
  it('allows/warns/blocks login and flags Turnstile, OAuth and non-HTTPS', () => {
    expect(evaluateStatus(COMPAT, ORIGIN, { success: true, data: { version: 'v1.0.0-rc.46' } })).toMatchObject({ verdict: 'ok', allowLogin: true, messages: [] });
    const newer = evaluateStatus(COMPAT, ORIGIN, { success: true, data: { version: 'v1.0.1' } });
    expect(newer).toMatchObject({ verdict: 'untested', allowLogin: true });
    expect(newer.messages[0]).toContain('高于');
    expect(evaluateStatus(COMPAT, ORIGIN, { success: true, data: { version: 'v1.0.0-rc.1' } })).toMatchObject({ verdict: 'too-old', allowLogin: false });
    expect(evaluateStatus(COMPAT, ORIGIN, { hello: 'world' })).toMatchObject({ verdict: 'not-new-api', allowLogin: false });
    expect(evaluateStatus(COMPAT, ORIGIN, { success: true, data: { version: 'v1.0.0-rc.46', turnstile_check: true } })).toMatchObject({ allowLogin: false, turnstile: true });
    expect(evaluateStatus(COMPAT, ORIGIN, { success: true, data: { version: 'v1.0.0-rc.46', github_oauth: true } }).unsupported).toEqual(['GitHub']);
    const http = evaluateStatus(COMPAT, 'http://127.0.0.1:3000', { success: true, data: { version: 'v1.0.0-rc.46' } });
    expect(http).toMatchObject({ allowLogin: true, insecureTransport: true }); // warning only
    expect(http.messages.join()).toContain('HTTPS');
  });
  it('checkServer sends no credentials, does not follow redirects, handles failure', async () => {
    const f = vi.fn(async (_u: string, _i: RequestInit) => new Response(JSON.stringify({ success: true, data: { version: 'v1.0.0-rc.46' } })));
    const c = await checkServer(COMPAT, ORIGIN, f);
    expect(c.verdict).toBe('ok');
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(`${ORIGIN}/api/status`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', credentials: 'omit' });
    expect(Object.keys(init.headers as object).map((k) => k.toLowerCase())).not.toContain('cookie');
    expect((await checkServer(COMPAT, ORIGIN, async () => new Response(null, { status: 302, headers: { location: 'https://x' } }))).verdict).toBe('not-new-api');
    const down = await checkServer(COMPAT, ORIGIN, async () => { throw new Error('ECONNREFUSED'); });
    expect(down).toMatchObject({ verdict: 'unreachable', allowLogin: false });
  });
});

describe('app protocol + proxy', () => {
  it('routes server paths to the proxy, re-applies CSP and drops Set-Cookie', async () => {
    const r = await handleAppRequest({ url: 'pac://app/api/status', method: 'GET' }, '/nonexistent', 'pac', undefined,
      async () => new Response('{}', { headers: { 'set-cookie': 'a=b', 'content-type': 'application/json' } }));
    expect(r.headers.get('set-cookie')).toBeNull();
    expect(r.headers.get('content-security-policy')).toContain("default-src 'self'");
  });
});

describe('Aegis #2: runtime classify == scripts/compat-check.mjs serverCompat', () => {
  it('agrees on a version table for both policies', async () => {
    // @ts-expect-error untyped .mjs
    const { serverCompat } = await import('../../../scripts/compat-check.mjs');
    const versions = ['v1.0.0-rc.40', 'v1.0.0-rc.46', 'v1.0.0-rc.47', 'v1.0.0', 'v1.0.9', 'v1.1.0', 'v2.0.0', 'v0.9.0', 'garbage'];
    for (const policy of ['same-minor-line', 'exact'] as const) for (const maxServerTested of [null, 'v1.0.0-rc.46', 'v1.0.0']) {
      const c: CompatRange = { tag: 'v1.0.0-rc.46', minServer: 'v1.0.0-rc.46', maxServerTested, policy };
      for (const v of versions) {
        const rt = classify(c, v);
        expect(rt === 'not-new-api' ? 'incompatible' : rt, `${policy} ${maxServerTested} ${v}`).toBe(serverCompat(c, v));
      }
    }
  });
});

describe('Aegis #3/#4: unreachable retry, pre-login re-check, trailing slashes', () => {
  const C: CompatRange = { tag: 'v1.0.0-rc.46', minServer: 'v1.0.0-rc.46', maxServerTested: null, policy: 'same-minor-line' };
  it('retries with backoff while unreachable, and a login attempt re-checks first', async () => {
    const { ServerSession } = await import('../src/main/proxy/server-session');
    let up = false; const seen: string[] = [];
    const fetch = vi.fn(async (url: string) => {
      if (!up) throw new Error('ECONNREFUSED');
      if (url.endsWith('/api/status')) return Response.json({ success: true, data: { version: 'v1.0.0-rc.46' } });
      return Response.json({ success: true, data: {} });
    });
    const s = new ServerSession({ compat: C, fetch, file: null, cipher: null, retry: { baseMs: 10, maxMs: 40 }, onCheck: (c) => seen.push(c.verdict) });
    await s.setServer('https://na.example.test');
    expect((await s.runCheck())?.verdict).toBe('unreachable');
    expect(s.nextRetryMs).toBe(10);
    await new Promise((r) => setTimeout(r, 20));
    expect(s.nextRetryMs).toBe(20); // doubled
    await new Promise((r) => setTimeout(r, 30));
    expect(s.nextRetryMs).toBe(40);
    up = true;
    // Login before the next retry fires: proxy re-checks, then forwards.
    const res = await s.handle({ method: 'POST', url: 'pac://app/api/user/login', headers: new Headers({ 'content-type': 'application/json' }), body: new TextEncoder().encode('{}').buffer as ArrayBuffer });
    expect(res.status).toBe(200);
    expect(s.serverCheck?.verdict).toBe('ok');
    expect(s.nextRetryMs).toBeNull();
    expect(seen.filter((v) => v === 'unreachable').length).toBeGreaterThanOrEqual(3);
    s.dispose();
  });
  it('server change cancels retries', async () => {
    const { ServerSession } = await import('../src/main/proxy/server-session');
    const s = new ServerSession({ compat: C, fetch: async () => { throw new Error('down'); }, file: null, cipher: null, retry: { baseMs: 1000, maxMs: 1000 } });
    await s.setServer('https://a.example.test'); await s.runCheck();
    expect(s.nextRetryMs).toBe(1000);
    await s.setServer('https://b.example.test');
    expect(s.nextRetryMs).toBeNull();
    s.dispose();
  });
  it('login paths with trailing slashes are gated like the bare path', async () => {
    const { calls, req } = setup({ check: evaluateStatus(C, ORIGIN, { success: true, data: { version: 'v1.0.0-rc.40' } }) });
    for (const p of ['/api/user/login/', '/api/user/login//', '/api/user/login/2fa/', '/api/user/register/', '/api/user/auth/refresh/']) {
      const r = await req('POST', p, { 'content-type': 'application/json' }, '{}');
      expect(r.status, p).toBe(403);
      expect(((await r.json()) as { code: string }).code).toBe('LOGIN_BLOCKED');
    }
    expect(calls).toHaveLength(0);
  });
  it('logout with a trailing slash clears the main session', async () => {
    const { jar, vault, req } = setup();
    vault.issue('real'); jar.store(['new_api_refresh=abc; Path=/api/user/auth; HttpOnly'], '/api/user/auth/refresh');
    await req('POST', '/api/user/auth/logout/');
    expect(vault.size).toBe(0); expect(jar.all()).toHaveLength(0);
  });
});
