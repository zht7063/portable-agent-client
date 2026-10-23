// M7 (Aegis): bare-key masking supports custom lengths / - and _ while leaving ordinary IDs alone.
import { describe, expect, it } from 'vitest';
import { AccessTokenVault, looksLikeBareKey, maskString, sanitizeJson } from '../../src/main/proxy/sanitize';

// Synthetic, deterministic fixtures (never real keys).
const rnd = (n: number, alphabet = 'aB3xQ9mZ7kR2pL5tW8vN4cY6') => Array.from({ length: n }, (_, i) => alphabet[(i * 7 + (i >> 2)) % alphabet.length]).join('');
const KEY48 = rnd(48);
const KEY_DASH = `${rnd(20)}-${rnd(18)}_${rnd(12)}`;

describe('bare key masking: positives', () => {
  it.each([16, 32, 48, 64, 128])('sk- key of length %i (with - and _) is masked in free text', (n) => {
    const k = `sk-${rnd(n - 3)}_-x`; // body length n
    const out = maskString(`err: bad key ${k} given`);
    expect(out).not.toContain(k);
    expect(out).toContain('**********');
  });
  it.each([['48 alnum', KEY48], ['with - and _', KEY_DASH], ['32 chars', rnd(32)], ['100 chars', rnd(100)]])('unprefixed %s key is masked', (_n, k) => {
    expect(looksLikeBareKey(k)).toBe(true);
    expect(maskString(`invalid token ${k}.`)).not.toContain(k);
  });
  it('ambiguous key field holding an unprefixed custom-format key is masked', () => {
    const out = sanitizeJson({ data: { key: KEY_DASH, name: 'x' } }, new AccessTokenVault()) as { data: { key: string } };
    expect(out.data.key).not.toBe(KEY_DASH);
  });
});

describe('bare key masking: ordinary IDs are not masked', () => {
  const IDS = [
    ['48-hex', 'a3f9'.repeat(12)],
    ['48-HEX', 'A3F9'.repeat(12)],
    ['sha256', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['uuid', '123e4567-e89b-12d3-a456-426614174000'],
    ['uuid+suffix', '123e4567-e89b-12d3-a456-426614174000-20261024'],
    ['request id', '20261024030812345678901234567890abcdefghijklmnop'],
    ['constant', 'MAX_RETRY_COUNT_FOR_UPSTREAM_CHANNEL_REQUESTS_V2'],
    ['camel identifier', 'getUpstreamChannelModelMappingConfiguration2026'],
  ];
  it.each(IDS)('%s stays intact in free text', (_n, id) => {
    expect(looksLikeBareKey(id)).toBe(false);
    expect(maskString(`request ${id} failed`)).toBe(`request ${id} failed`);
  });
  it('high-entropy values are masked in id-like fields too (incl. nested objects/arrays)', () => {
    const out = JSON.stringify(sanitizeJson({ id: KEY48, request_id: KEY48, user_id: KEY_DASH, nested: { fooId: KEY48, list: [{ requestId: KEY48 }] }, trace_id: `sk-${KEY48}` }, new AccessTokenVault()));
    expect(out).not.toContain(KEY48);
    expect(out).not.toContain(KEY_DASH);
  });
  it('numeric / hex / UUID IDs in id-like fields stay intact', () => {
    const ids = { id: 1234567, request_id: '20261024030812345678901234567890', user_id: 'a3f9'.repeat(12), nested: { fooId: '123e4567-e89b-12d3-a456-426614174000', list: [{ requestId: 'E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855' }] } };
    expect(sanitizeJson(ids, new AccessTokenVault())).toEqual(ids);
  });
  it('option key names are not masked', () => {
    const out = sanitizeJson({ data: [{ key: 'SMTPServer', value: 'smtp.example.com' }] }, new AccessTokenVault());
    expect(out).toEqual({ data: [{ key: 'SMTPServer', value: 'smtp.example.com' }] });
  });
});

describe('base64 and data: URIs are not corrupted', () => {
  const b64 = (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255)).toString('base64');
  const pad4 = (x: string) => x + 'A'.repeat((4 - (x.length % 4)) % 4);
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).toString('base64'); // 16 chars
  it('data:image/png;base64,... is unchanged (also with an embedded high-entropy run bounded by + / and inside JSON)', () => {
    const uri = `data:image/png;base64,${pad4(`${PNG}${b64(30)}+${KEY48}/${b64(30)}`)}`;
    expect((uri.length - 'data:image/png;base64,'.length) % 4).toBe(0);
    expect(maskString(uri)).toBe(uri);
    expect(maskString(`<img src="${uri}">`)).toBe(`<img src="${uri}">`);
    const svg = `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg">${'<path d="M0 0"/>'.repeat(5)}</svg>`).toString('base64')}`;
    expect(sanitizeJson({ avatar: uri, logo: svg }, new AccessTokenVault())).toEqual({ avatar: uri, logo: svg });
  });
  it('a plain (unprefixed) base64 block with an embedded high-entropy 48-run bounded by + / = is unchanged', () => {
    for (const blob of [pad4(`${b64(30)}/${KEY48}+${b64(30)}`), `${pad4(`${b64(24)}+${KEY48}+${b64(24)}`)}`, `x: ${pad4(`${b64(30)}+${KEY48}/${b64(30)}`)} end`]) {
      expect(blob.replace(/^x: | end$/g, '').length % 4).toBe(0);
      expect(maskString(blob)).toBe(blob);
    }
  });
  it('a normal bare key next to a data: URI is still masked', () => {
    const out = maskString(`img data:image/png;base64,${b64(30)} key ${KEY48} end`);
    expect(out).not.toContain(KEY48);
    expect(out).toContain(`data:image/png;base64,${b64(30)}`);
    expect(maskString(`error: raw=${KEY48}`)).not.toContain(KEY48);
  });
  it('data:image payload without an image header is not an image span (K bounded by + / is masked)', () => {
    const uri = `data:image/png;base64,/${KEY48}+${'A'.repeat(14)}`; // valid length, no image magic, starts with '/' (not a block)
    expect(maskString(`${uri}`)).not.toContain(KEY48);
  });
});

describe('URL / path echoes (Aegis): K is masked next to / + =', () => {
  it.each([
    ['https://h/K', `https://h/${KEY48}`],
    ['https://h/v1/K/x', `https://h/v1/${KEY48}/x`],
    ['path/K', `path/${KEY48}`],
    ['/K end', `/${KEY48} end`],
    ['K/x', `${KEY48}/x`],
    ['K+', `${KEY48}+`],
    ['K=', `${KEY48}=`],
    ['x+K', `x+${KEY48}`],
    ['long API path', `GET https://api.example.com/api/v1/tokens/${KEY48}/details?x=1 failed`],
    ['relative long path', `v1/tokens/${KEY48}/details/usage/summary/by/day/2026`],
  ])('%s', (_n, text) => {
    expect(maskString(text)).not.toContain(KEY48);
    expect(JSON.stringify(sanitizeJson({ message: text, nested: [{ url: text }] }, new AccessTokenVault()))).not.toContain(KEY48);
  });
});

describe('data: bypass regressions (Aegis): K is masked in every non-image / invalid form', () => {
  const b64 = (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255)).toString('base64');
  it.each([
    ['data:,K', `data:,${KEY48}`],
    ['data:x,K', `data:x,${KEY48}`],
    ['data:;base64,K', `data:;base64,${KEY48}`],
    ['img src data:…,K', `<img src="data:text/plain,${KEY48}">`],
    ['img src data:image short payload', `<img src="data:image/png;base64,${KEY48}">`],
    ['metadata:,K', `metadata:,${KEY48}`],
    ['metadata:image/png;base64,…K', `metadata:image/png;base64,${b64(48)} ${KEY48}`],
    ['abc==K', `abc==${KEY48}`],
    ['key=K', `key=${KEY48}`],
    ['K after a valid image span', `data:image/png;base64,${b64(60)} ${KEY48}`],
  ])('%s', (_n, text) => {
    expect(maskString(text)).not.toContain(KEY48);
    expect(JSON.stringify(sanitizeJson({ v: text }, new AccessTokenVault()))).not.toContain(KEY48);
  });
  it('a key embedded verbatim in a valid image payload, not bounded by + / =, is masked', () => {
    const text = `data:image/png;base64,${KEY48}${KEY48}`; // valid 96-char payload; the run has no + / = around it
    expect(maskString(text)).not.toContain(KEY48);
  });
  it('legit inline PNG base64 (valid alphabet, padding, >= 64 chars) stays intact, incl. high-entropy runs bounded by + / =', () => {
    for (const n of [48, 49, 50, 300]) {
      const uri = `data:image/png;base64,${b64(n)}`;
      expect(maskString(uri)).toBe(uri);
      expect(maskString(`<img src="${uri}" alt="x">`)).toBe(`<img src="${uri}" alt="x">`);
    }
    const inner = `data:image/png;base64,${b64(30)}+${KEY48}/${b64(30)}AA`;
    expect(inner.split(',')[1]!.length % 4).toBe(0);
    expect(maskString(inner)).toBe(inner);
  });
});

describe('data:image magic header check', () => {
  const body = Buffer.from(Array.from({ length: 120 }, (_, i) => (i * 53 + 7) & 255));
  const uri = (head: number[] | string, t = 'png') => `data:image/${t};base64,${Buffer.concat([Buffer.from(head as never), body]).toString('base64')}`;
  it.each([
    ['png', uri([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ['jpeg (/9j/)', uri([0xff, 0xd8, 0xff, 0xe0], 'jpeg')],
    ['gif', uri('GIF89a', 'gif')],
    ['webp', uri('RIFF\u0000\u0000\u0000\u0000WEBP', 'webp')],
    ['svg', uri('<svg xmlns="http://www.w3.org/2000/svg">', 'svg+xml')],
  ])('%s payload with a valid header is left intact', (_n, u) => {
    expect(maskString(`<img src="${u}">`)).toBe(`<img src="${u}">`);
  });
});
