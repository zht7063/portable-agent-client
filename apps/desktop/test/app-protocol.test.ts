import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRODUCT } from '@pac/core';
import { buildCsp, handleAppRequest, isAppUrl, navigationDecision, resolveRequest, externalUrl, appOrigin } from '../src/main/app-protocol';
import { isTrustedSender, type FrameLike } from '../src/main/ipc/sender';

const S = PRODUCT.protocolScheme;
const O = appOrigin(S);
let base: string; let root: string; let prevHome: string | undefined;

beforeAll(() => {
  prevHome = process.env.HOME;
  base = mkdtempSync(join(tmpdir(), 'pac-proto-'));
  process.env.HOME = join(base, 'home');
  root = join(base, 'renderer');
  mkdirSync(join(root, 'static', 'js'), { recursive: true });
  writeFileSync(join(root, 'index.html'), '<!doctype html><div id="root"></div>');
  writeFileSync(join(root, 'static', 'js', 'a.js'), 'console.log(1)');
  writeFileSync(join(base, 'secret.txt'), 'TOP-SECRET');
  mkdirSync(join(base, 'renderer-evil'));
  writeFileSync(join(base, 'renderer-evil', 'x.js'), 'evil');
});
afterAll(() => { rmSync(base, { recursive: true, force: true }); process.env.HOME = prevHome; });

describe('resolveRequest / path traversal', () => {
  it('maps files inside root and SPA routes', () => {
    expect(resolveRequest(`${O}/static/js/a.js`, root, S)).toEqual({ kind: 'file', path: join(root, 'static', 'js', 'a.js') });
    expect(resolveRequest(`${O}/`, root, S)).toEqual({ kind: 'spa' });
    expect(resolveRequest(`${O}/console/token?x=1#h`, root, S)).toEqual({ kind: 'spa' });
  });
  it.each([
    `${O}/..%2fsecret.txt`,
    `${O}/..%5csecret.txt`,
    `${O}/static%2f..%2f..%2fsecret.txt`,
    `${O}/a%00.js`,
    `${O}/%E0%A4%A.js`,
    `${O}/static\\..\\..\\secret.txt`,
  ])('rejects %s', (url) => {
    expect(resolveRequest(url, root, S).kind).toBe('reject');
  });
  it.each([`${O}/../renderer-evil/x.js`, `${O}/%2e%2e/secret.txt`, `${O}/static/%2e%2e/%2e%2e/secret.txt`, `${O}/./../../secret.txt`])(
    'URL-normalised dot segments stay confined to root: %s', (url) => {
      const r = resolveRequest(url, root, S);
      if (r.kind === 'file') expect(r.path.startsWith(join(root, '/'))).toBe(true);
      else expect(['reject', 'spa']).toContain(r.kind);
    });
  it('rejects foreign scheme/host', () => {
    expect(resolveRequest('file:///etc/passwd', root, S)).toEqual({ kind: 'reject', status: 403 });
    expect(resolveRequest(`${S}://evil/index.html`, root, S)).toEqual({ kind: 'reject', status: 403 });
  });
  it('classifies server paths', () => {
    for (const p of ['/api/status', '/api', '/v1/models', '/mj/x', '/pg/x']) expect(resolveRequest(`${O}${p}`, root, S)).toEqual({ kind: 'server' });
    expect(resolveRequest(`${O}/apidocs.js`, root, S).kind).toBe('file');
  });
});

describe('handleAppRequest', () => {
  const get = (p: string, method = 'GET') => handleAppRequest({ url: `${O}${p}`, method }, root, S);
  it('serves files with MIME + strict CSP and hardening headers', async () => {
    const r = await get('/static/js/a.js');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/javascript/);
    expect(await r.text()).toBe('console.log(1)');
    const csp = r.headers.get('content-security-policy')!;
    expect(csp).toBe(buildCsp(S));
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
  });
  it('CSP: no remote origins, no inline/eval scripts, connect only self/app', () => {
    const csp = buildCsp(S);
    const d = Object.fromEntries(csp.split('; ').map((x) => { const [k, ...v] = x.split(' '); return [k, v]; }));
    expect(d['script-src']).toEqual(["'self'"]);
    expect(d['connect-src']).toEqual(["'self'", `${S}:`]);
    expect(d['default-src']).toEqual(["'self'"]);
    for (const k of ['frame-src', 'object-src', 'base-uri', 'form-action', 'frame-ancestors']) expect(d[k]).toEqual(["'none'"]);
    expect(csp).not.toMatch(/https?:|\*|unsafe-eval/);
  });
  it('SPA fallback returns index.html for routes', async () => {
    const r = await get('/console/token');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/html/);
    expect(await r.text()).toContain('id="root"');
  });
  it('traversal attempts never leak files outside root', async () => {
    for (const p of ['/%2e%2e/secret.txt', '/..%2fsecret.txt', '/static/%2e%2e/%2e%2e/secret.txt']) {
      const r = await get(p);
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(await r.text()).not.toContain('TOP-SECRET');
    }
  });
  it('missing asset → 404, non-GET → 405, HEAD has no body', async () => {
    expect((await get('/static/nope.js')).status).toBe(404);
    expect((await get('/index.html', 'POST')).status).toBe(405);
    const h = await get('/index.html', 'HEAD');
    expect(h.status).toBe(200);
    expect(await h.text()).toBe('');
  });
  it('/api/* is a 503 stub in M2 (no network), with CSP', async () => {
    for (const m of ['GET', 'POST']) {
      const r = await get('/api/user/login', m);
      expect(r.status).toBe(503);
      expect(((await r.json()) as { message: string }).message).toMatch(/not implemented in M2/);
      expect(r.headers.get('content-security-policy')).toBe(buildCsp(S));
    }
  });
});

describe('navigation guards', () => {
  it('in-app navigation allowed, window.open of app URL denied', () => {
    expect(navigationDecision(`${O}/console`, S, 'navigate')).toEqual({ action: 'allow' });
    expect(navigationDecision(`${O}/console`, S, 'open')).toEqual({ action: 'deny' });
  });
  it('https links go to the OS browser (after confirmation); plain http is denied', () => {
    expect(navigationDecision('https://github.com/QuantumNous/new-api', S, 'open')).toEqual({ action: 'external', url: 'https://github.com/QuantumNous/new-api' });
    expect(navigationDecision('http://example.com/', S, 'navigate')).toEqual({ action: 'deny' });
    expect(navigationDecision('http://example.com/', S, 'open')).toEqual({ action: 'deny' });
  });
  it('CSP is exactly the plan v2 §2 policy plus frame-ancestors', () => {
    expect(buildCsp(S)).toBe(`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' ${S}:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
  });
  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', `${S}://evil/`, 'devtools://devtools', 'about:blank', 'smb://host/share', 'https://u:p@example.com/', 'nope'])(
    'denies %s', (url) => {
      expect(navigationDecision(url, S, 'navigate')).toEqual({ action: 'deny' });
      expect(navigationDecision(url, S, 'open')).toEqual({ action: 'deny' });
    });
  it('isAppUrl / externalUrl', () => {
    expect(isAppUrl(`${O}/x`, S)).toBe(true);
    expect(isAppUrl(`${S}://app.evil/x`, S)).toBe(false);
    expect(externalUrl('mailto:a@b')).toBeNull();
  });
  it('IPC sender predicate accepts any route on the app origin only', () => {
    const mk = (url: string) => { const mainFrame: FrameLike = { url, parent: null }; const webContents = { mainFrame }; return { win: { webContents }, webContents, mainFrame }; };
    const ok = mk(`${O}/console/token`);
    expect(isTrustedSender({ sender: ok.webContents, senderFrame: ok.mainFrame }, ok.win, (u) => isAppUrl(u, S))).toBe(true);
    const bad = mk('https://evil.example/');
    expect(isTrustedSender({ sender: bad.webContents, senderFrame: bad.mainFrame }, bad.win, (u) => isAppUrl(u, S))).toBe(false);
  });
});
