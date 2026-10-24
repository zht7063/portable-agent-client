// Aegis M7: percent-encoded paths are decoded once before every decision (DENY, allowlist, 409 guards).
import { describe, expect, it, vi } from 'vitest';
import { CookieJar } from '../../src/main/proxy/cookie-jar';
import { AccessTokenVault } from '../../src/main/proxy/sanitize';
import { ServerProxy } from '../../src/main/proxy/api-proxy';
import { canonicalisePath } from '../../src/main/proxy/allowlist';

const ORIGIN = 'https://na.example.test';
function setup() {
  const fetch = vi.fn(async () => new Response('{"success":true}', { headers: { 'content-type': 'application/json' } }));
  const p = new ServerProxy({ getOrigin: () => ORIGIN, getCheck: () => null, getJar: () => new CookieJar(), vault: new AccessTokenVault(), fetch });
  const req = (method: string, path: string, body?: unknown) => p.handle({ method, url: `pac://app${path}`, headers: new Headers({ 'content-type': 'application/json' }), body: body === undefined ? null : new TextEncoder().encode(JSON.stringify(body)).buffer as ArrayBuffer });
  return { fetch, req };
}
const MASK = 'abcd**********wxyz';

describe('encoded paths cannot bypass the 409 masked-save guard', () => {
  it.each([
    ['PUT', '/api/user/sett%69ng', { webhook_secret: MASK }], ['PUT', '/api/user/sett%49ng'.replace('%49', '%69'), { webhook_secret: MASK }],
    ['PUT', '/api/user/SETT%69NG'.toLowerCase(), { webhook_secret: MASK }],
    ['PUT', '/api/user/s%65lf', { password: MASK }], ['PUT', '/api/user/s%65LF'.replace('LF', 'lf'), { password: MASK }],
    ['PUT', '/api/%63hannel/', { key: MASK }], ['PUT', '/api/%63hannel/%31', { key: MASK }], ['PUT', '/api/channel/%31', { key: MASK }],
    ['PUT', '/api/%6F%70tion/', { value: MASK }], ['PUT', '/api/%6f%70tion/', { value: MASK }],
  ])('%s %s -> 409, nothing sent', async (m, p, b) => {
    const { fetch, req } = setup();
    expect((await req(m, p, b)).status).toBe(409);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('encoded paths cannot bypass DENY', () => {
  it.each([
    '/api/user/epay/n%6Ftify', '/api/user/epay/n%6ftify', '/api/subscription/epay/%6Eotify', '/api/stripe/webh%6Fok',
    '/api/user/login/p%61sskey/begin', '/api/user/passkey/l%6Fgin/finish', '/api/o%61uth/github',
  ])('POST %s -> 403', async (p) => {
    const { fetch, req } = setup();
    expect((await req('POST', p, {})).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('malformed / dangerous encodings are refused (400)', () => {
  it.each([
    '/api/user%2Fsetting', '/api/user%2fsetting', '/api/user/sett%2569ng', '/api/user/%25',
    '/api/user/%zz', '/api/user/%', '/api/user/%6', '/api/user/a%00b', '/api/user/a%5Cb', '/api/user/a%0Ab', '/api/user/%C0%AF',
  ])('%s', async (p) => {
    const { fetch, req } = setup();
    expect((await req('GET', p)).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('dot-segment encodings never reach upstream', () => {
  // WHATWG URL parsing already resolves %2e%2e as '..' before the proxy sees the path; either way nothing is sent.
  it.each(['/api/user/%2e%2e/x', '/api/%2E%2E/v1/x', '/api/user/%2e/setting'])('%s', async (p) => {
    const { fetch, req } = setup();
    expect((await req('PUT', p, { webhook_secret: MASK })).status).toBeGreaterThanOrEqual(400);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('legit encoded segments still work and are forwarded canonically', () => {
  it('session id / plugin version with encoded chars', async () => {
    const { fetch, req } = setup();
    expect((await req('DELETE', '/api/user/sessions/a%20b')).status).toBe(200);
    expect((await req('GET', '/api/plugin/task/k/versions/1.0.0%2Bbuild?q=%41%2F')).status).toBe(200);
    const urls = fetch.mock.calls.map((c) => (c as unknown as [string])[0]);
    expect(urls).toEqual([`${ORIGIN}/api/user/sessions/a%20b`, `${ORIGIN}/api/plugin/task/k/versions/1.0.0%2Bbuild?q=%41%2F`]);
  });
  it('decoded path is what gets checked; wire is the canonical re-encoding', () => {
    expect(canonicalisePath('/api/user/sett%69ng')).toEqual({ path: '/api/user/setting', wire: '/api/user/setting' });
    expect(canonicalisePath('/api/x/a%2bb')).toEqual({ path: '/api/x/a+b', wire: '/api/x/a%2Bb' });
  });
});
