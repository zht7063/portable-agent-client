// Aegis M7 (review of 5c417bd): 1a known-value masking everywhere (incl. forged data:image), 2 masked-save guard for
// base64-ish secret fields, 3 SSE line-wise sanitising.
import { describe, expect, it, vi } from 'vitest';
import { CookieJar } from '../../src/main/proxy/cookie-jar';
import { AccessTokenVault, HANDLE_PREFIX, MIN_KNOWN, knownSet, maskString, replaceKnown, sanitizeJson, sseSanitizer, SSE_TOO_LARGE_FRAME, isPemPublicKey } from '../../src/main/proxy/sanitize';
import { ServerProxy } from '../../src/main/proxy/api-proxy';
import { evaluateStatus } from '../../src/main/proxy/server-status';

const ORIGIN = 'https://na.example.test';
const K = 'Zq7Rw2Lp9Xv4Tm8Nk3Hd6Jf1Bc5Gs0YeQa2Wu7Ir4Ot9Pl3S'; // 48-char key-shaped secret
const fill = (magic: number[] | string) => {
  const m = typeof magic === 'string' ? Buffer.from(magic) : Buffer.from(magic);
  return Buffer.concat([m, Buffer.from('x'.repeat(69 - m.length))]).toString('base64'); // 92 chars, no padding
};
const HEADERS: Record<string, string> = {
  png: fill([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  jpeg: fill([0xff, 0xd8, 0xff, 0xe0]),
  gif: fill('GIF89a'),
  webp: fill([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP')]),
  'svg+xml': fill('<svg xmlns="http://www.w3.org/2000/svg">'),
};
/** Header-valid payload with K bounded by + and / (the heuristic deliberately leaves it alone). */
const forged = (sub: string, key = K) => `data:image/${sub};base64,${HEADERS[sub]}+${key}/${HEADERS[sub]}AA`;

describe('premise: the heuristic alone does not mask K inside a forged header-valid payload', () => {
  it.each(Object.keys(HEADERS))('%s', (sub) => { expect(maskString(forged(sub))).toContain(K); });
});

function proxyWith(body: string, ct: string) {
  const vault = new AccessTokenVault();
  const h = vault.issue(K);
  const fetch = vi.fn(async () => new Response(body, { headers: { 'content-type': ct } }));
  const p = new ServerProxy({ getOrigin: () => ORIGIN, getCheck: () => evaluateStatus({ tag: 'v1.0.0-rc.46', minServer: 'v1.0.0-rc.46', maxServerTested: null, policy: 'same-minor-line' }, ORIGIN, { success: true, data: { version: 'v1.0.0-rc.46' } }), getJar: () => new CookieJar(), vault, fetch });
  return (path = '/api/user/self', method = 'GET') => p.handle({ method, url: `pac://app${path}`, headers: new Headers({ authorization: `Bearer ${h}` }), body: null });
}

describe('1a known keys are masked everywhere, including forged data:image payloads', () => {
  const shapes = (sub: string): [string, string][] => [
    ['plain', forged(sub)],
    ['uppercase', forged(sub).replace('data:image/', 'DATA:IMAGE/').replace(sub, sub.toUpperCase())],
    ['markdown', `look ![x](${forged(sub)}) ok`],
  ];
  for (const sub of Object.keys(HEADERS)) {
    for (const [name, s] of shapes(sub)) {
      it(`${sub} ${name}: sanitizeJson (vault token, JSON message field)`, () => {
        const v = new AccessTokenVault(); v.issue(K);
        const out = JSON.stringify(sanitizeJson({ success: false, message: s, data: { content: s } }, v));
        expect(out).not.toContain(K);
      });
      it(`${sub} ${name}: sanitizeJson (value under a secret field elsewhere in the body)`, () => {
        const out = JSON.stringify(sanitizeJson({ data: { api_key: K, note: s } }, new AccessTokenVault()));
        expect(out).not.toContain(K);
      });
      it(`${sub} ${name}: proxy JSON message, text body and SSE`, async () => {
        for (const [body, ct] of [[JSON.stringify({ success: false, message: s }), 'application/json'], [s, 'text/plain'], [`data: ${JSON.stringify({ c: s })}\n\n`, 'text/event-stream']] as const) {
          const res = await proxyWith(body, ct)();
          expect(await res.text()).not.toContain(K);
        }
      });
    }
  }
  it('min length guard: values shorter than MIN_KNOWN are not used for exact replacement', () => {
    expect(knownSet(['abc', 'x'.repeat(MIN_KNOWN - 1), 'y'.repeat(MIN_KNOWN)])).toEqual(['y'.repeat(MIN_KNOWN)]);
    expect(replaceKnown('a abc b', knownSet(['abc']))).toBe('a abc b');
  });
  it('already-masked values and handles are not treated as known', () => {
    expect(knownSet(['abcd**********wxyz', `${HANDLE_PREFIX}xxxxxxxxxxxxxxxx`])).toEqual([]);
  });
  it('user setting JSON-in-a-string: webhook_secret masked and known everywhere', () => {
    const W = 'whsec-plain-but-secret-value-123';
    const out = sanitizeJson({ data: { setting: JSON.stringify({ webhook_secret: W }), note: `x ${W} y` } }, new AccessTokenVault()) as { data: { setting: string } };
    expect(JSON.stringify(out)).not.toContain(W);
    expect(JSON.parse(out.data.setting).webhook_secret).toMatch(/\*{10}/);
  });
});

describe('3 SSE is sanitised line-wise across chunk boundaries', () => {
  const run = async (chunks: string[], known: string[] = []) => {
    const enc = new TextEncoder();
    const rs = new ReadableStream<Uint8Array>({ start(c) { for (const x of chunks) c.enqueue(enc.encode(x)); c.close(); } });
    return new Response(rs.pipeThrough(sseSanitizer(knownSet(known)))).text();
  };
  it('key split across every possible chunk boundary is masked', async () => {
    const s = `data: {"delta":"here ${K} there"}\n\n`;
    for (let i = 1; i < s.length; i++) expect(await run([s.slice(0, i), s.slice(i)])).not.toContain(K);
  });
  it('multi-byte UTF-8 split across chunks survives', async () => {
    const bytes = new TextEncoder().encode('data: 你好\n\n');
    const rs = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes.slice(0, 8)); c.enqueue(bytes.slice(8)); c.close(); } });
    expect(await new Response(rs.pipeThrough(sseSanitizer([]))).text()).toBe('data: 你好\n\n');
  });
  it('ordinary frames pass unchanged and complete lines are emitted without waiting for the stream end', async () => {
    const t = sseSanitizer([]); const w = t.writable.getWriter(); const r = t.readable.getReader();
    void w.write(new TextEncoder().encode('data: {"delta":"hi"}\n'));
    expect(new TextDecoder().decode((await r.read()).value)).toBe('data: {"delta":"hi"}\n');
    void w.write(new TextEncoder().encode('\ndata: [DONE]')); void w.close();
    let rest = ''; for (;;) { const x = await r.read(); if (x.done) break; rest += new TextDecoder().decode(x.value); }
    expect(rest).toBe('\ndata: [DONE]');
  });
  const bigImage = (mb: number) => {
    const png = Buffer.alloc(Math.floor((mb << 20) / 3) * 3); // multiple of 3 -> no padding
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    let x = 7; for (let i = 8; i < png.length; i++) { x = (x * 1103515245 + 12345) >>> 0; png[i] = x >>> 24; }
    return png.toString('base64');
  };
  const chunked = (s: string, n: number) => { const out: string[] = []; for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n)); return out; };
  it('4 MB data:image line across ~1000 chunks: byte-identical, no hard cut', async () => {
    const line = `data: {"data":[{"url":"data:image/png;base64,${bigImage(4)}"}]}\n\ndata: [DONE]\n\n`;
    expect(line.length).toBeGreaterThan(5 << 20);
    const out = await run(chunked(line, 5000));
    expect(out.length).toBe(line.length);
    expect(out === line).toBe(true);
  });
  it('known key inside a 2 MB data:image payload (bounded by + /) across chunks is masked', async () => {
    const b = bigImage(2);
    const line = `data: {"url":"data:image/png;base64,${b.slice(0, 4000)}+${K}/${b.slice(4000)}AA"}\n\n`;
    const out = await run(chunked(line, 4096), [K]);
    expect(out).not.toContain(K);
  });
  it('a line beyond the limit is not forwarded; the stream ends with an SSE error frame', async () => {
    const t = sseSanitizer([], 1000);
    const enc = new TextEncoder();
    const rs = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode('data: ok\n')); for (let i = 0; i < 5; i++) c.enqueue(enc.encode(`x${K}`.repeat(10))); c.close(); } });
    const out = await new Response(rs.pipeThrough(t)).text();
    expect(out).toBe(`data: ok\n${SSE_TOO_LARGE_FRAME}`);
  });
  it('known value (not key-shaped) masked in SSE', async () => {
    expect(await run(['data: tok=lowercase-known-', 'secret-value\n'], ['lowercase-known-secret-value'])).not.toContain('lowercase-known-secret-value');
  });
});

describe('2 masked values from base64-ish secret fields are never submitted upstream (409)', () => {
  const mask = maskString(`x ${K} y`).slice(2, -2); // the exact '*' run our masking produces
  const pem = `-----BEGIN PRIVATE KEY-----\nMIIEv${mask}\n-----END PRIVATE KEY-----\n`;
  const cases: [string, string, unknown][] = [
    ['PUT', '/api/user/setting', { notify_type: 'webhook', webhook_url: 'https://h/x', webhook_secret: mask }],
    ['PUT', '/api/option/', { key: 'WaffoPrivateKey', value: pem }],
    ['PUT', '/api/option/', { key: 'WaffoPublicCert', value: pem.replace(/PRIVATE KEY/g, 'CERTIFICATE') }],
    ['PUT', '/api/option/', { key: 'StripeWebhookSecret', value: mask }],
    ['PUT', '/api/option/', { key: 'CreemWebhookSecret', value: mask }],
    ['PUT', '/api/option/', { key: 'TurnstileSecretKey', value: mask }],
    ['POST', '/api/option/waffo-pancake/save', { private_key: pem }],
    ['PUT', '/api/channel/', { id: 1, type: 41, key: JSON.stringify({ type: 'service_account', private_key: pem, client_email: 'a@b' }) }],
    ['PUT', '/api/channel/', { id: 1, type: 33, key: `AKID|${mask}|us-east-1` }],
    ['POST', '/api/custom-oauth-provider/', { name: 'x', client_secret: mask }],
    ['POST', '/api/deployments/', { registry_secret: mask, secret_env_variables: { A: mask } }],
  ];
  it.each(cases)('%s %s', async (method, path, body) => {
    const fetch = vi.fn();
    const vault = new AccessTokenVault();
    const p = new ServerProxy({ getOrigin: () => ORIGIN, getCheck: () => null, getJar: () => new CookieJar(), vault, fetch });
    const res = await p.handle({ method, url: `pac://app${path}`, headers: new Headers({ 'content-type': 'application/json' }), body: new TextEncoder().encode(JSON.stringify(body)).buffer as ArrayBuffer });
    expect(res.status).toBe(409);
    expect(fetch).not.toHaveBeenCalled();
  });

});

describe('3 login PEM exemption: parsed public key, top-level data.public_key only', () => {
  const { generateKeyPairSync } = require('node:crypto') as typeof import('node:crypto');
  const kp = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pub = kp.publicKey.export({ type: 'spki', format: 'pem' }) as string;
  const priv = kp.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  const garbage = `-----BEGIN PUBLIC KEY-----\n${K}AAAA\n-----END PUBLIC KEY-----\n`;
  const get = async (body: unknown) => (await (await proxyWith(JSON.stringify(body), 'application/json')('/api/user/login/encryption-key')).json()) as { data: Record<string, unknown> };
  it('valid PEM passes intact', async () => {
    expect(isPemPublicKey(pub)).toBe(true);
    expect((await get({ success: true, data: { kid: 'k', public_key: pub } })).data.public_key).toBe(pub);
  });
  it('garbage PEM-looking text is not exempt', async () => {
    expect(isPemPublicKey(garbage)).toBe(false);
    expect((await get({ success: true, data: { public_key: garbage } })).data.public_key).not.toContain(K);
  });
  it('a private key (even relabelled) is not exempt', async () => {
    expect(isPemPublicKey(priv)).toBe(false);
    expect(isPemPublicKey(priv.replace(/PRIVATE KEY/g, 'PUBLIC KEY'))).toBe(false);
    expect((await get({ success: true, data: { public_key: priv } })).data.public_key).not.toBe(priv);
  });
  it('nested or top-level-outside-data public_key is not exempt', async () => {
    const r = await get({ success: true, public_key: pub, data: { inner: { public_key: pub }, list: [{ public_key: pub }] } });
    expect(JSON.stringify(r)).not.toContain(pub.split('\n')[1]);
  });
  it('on other paths data.public_key is not exempt', async () => {
    const res = await proxyWith(JSON.stringify({ data: { public_key: pub } }), 'application/json')('/api/user/self');
    expect(((await res.json()) as { data: { public_key: string } }).data.public_key).not.toBe(pub);
  });
});
