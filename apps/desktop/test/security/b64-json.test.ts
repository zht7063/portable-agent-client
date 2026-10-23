// Iris/Aegis M7: narrow per-field exception for image-generation `data[i].b64_json` (JSON and SSE data: lines).
import { describe, expect, it } from 'vitest';
import { AccessTokenVault, knownSet, maskString, sanitizeJson, sseSanitizer } from '../../src/main/proxy/sanitize';

const K = 'Zq7Rw2Lp9Xv4Tm8Nk3Hd6Jf1Bc5Gs0YeQa2Wu7Ir4Ot9Pl3S';
const MAGIC: Record<string, number[]> = {
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], jpeg: [0xff, 0xd8, 0xff, 0xe0], gif: [...Buffer.from('GIF89a')],
  webp: [...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP')],
};
/** Random-looking image bytes (high-entropy base64 that the plain heuristic would mangle). */
const img = (kind: string, n = 30000, magic = MAGIC[kind]!) => {
  const b = Buffer.alloc(n - (n % 3)); Buffer.from(magic).copy(b);
  let x = 11; for (let i = magic.length; i < b.length; i++) { x = (x * 1103515245 + 12345) >>> 0; b[i] = x >>> 24; }
  return b.toString('base64');
};
const v = () => new AccessTokenVault();
const sse = async (text: string, known: string[] = [], chunk = 997) => {
  const enc = new TextEncoder();
  const rs = new ReadableStream<Uint8Array>({ start(c) { for (let i = 0; i < text.length; i += chunk) c.enqueue(enc.encode(text.slice(i, i + chunk))); c.close(); } });
  return new Response(rs.pipeThrough(sseSanitizer(knownSet(known)))).text();
};

describe('premise: bare high-entropy base64 is mangled as plain text', () => {
  it('free text', () => expect(maskString(img('png'))).not.toBe(img('png')));
});

describe('positive: top-level data[i].b64_json with an image header is byte-identical', () => {
  for (const kind of Object.keys(MAGIC)) {
    it(`${kind} via sanitizeJson`, () => {
      const body = { created: 1, data: [{ b64_json: img(kind), revised_prompt: 'a cat' }, { b64_json: img(kind, 3000) }] };
      expect(sanitizeJson(body, v())).toEqual(body);
    });
    it(`${kind} via SSE (data: JSON line, many chunks)`, async () => {
      const text = `event: image\ndata: ${JSON.stringify({ type: 'image', data: [{ b64_json: img(kind) }] })}\n\ndata: {"data": [{"b64_json": "${img(kind, 999)}"}]}\n\ndata: [DONE]\n\n`;
      expect(await sse(text)).toBe(text);
    });
  }
  it('known key inside the payload is still masked (JSON and SSE); the image is sacrificed', async () => {
    const p = img('png'); const bad = `${p.slice(0, 400)}+${K}/${p.slice(400)}AA`;
    const vault = v(); vault.issue(K);
    expect(JSON.stringify(sanitizeJson({ data: [{ b64_json: bad }] }, vault))).not.toContain(K);
    expect(JSON.stringify(sanitizeJson({ data: [{ b64_json: bad, api_key: K }] }, v()))).not.toContain(K);
    expect(await sse(`data: ${JSON.stringify({ data: [{ b64_json: bad }] })}\n\n`, [K])).not.toContain(K);
  });
  it('text around the exempt value is still masked', async () => {
    const line = `data: ${JSON.stringify({ data: [{ b64_json: img('png'), note: `leak ${K}` }] })}\n`;
    expect(await sse(line)).not.toContain(K);
    expect(JSON.stringify(sanitizeJson(JSON.parse(line.slice(6)), v()))).not.toContain(K);
  });
});

describe('negative: not exempt (treated as plain text) -> a key bounded by + / inside is masked', () => {
  // K bounded by + and / survives only inside an exempt image payload; anywhere else the plain rules mask it.
  const withK = (p: string) => `${p.slice(0, 400)}+${K}/${p.slice(400)}AA`;
  const P = withK(img('png'));
  const cases: [string, unknown][] = [
    ['field b64', { data: [{ b64: P }] }],
    ['field image', { data: [{ image: P }] }],
    ['field b64_JSON', { data: [{ b64_JSON: P }] }],
    ['no image header', { data: [{ b64_json: withK(img('x', 30000, [0x00, 0x01, 0x02, 0x03])) }] }],
    ['svg is not accepted here', { data: [{ b64_json: withK(img('x', 30000, [...Buffer.from('<svg ')])) }] }],
    ['nested elsewhere: data[i].x.b64_json', { data: [{ x: { b64_json: P } }] }],
    ['nested elsewhere: result.data[i].b64_json', { result: { data: [{ b64_json: P }] } }],
    ['top-level b64_json', { b64_json: P }],
    ['data is an object', { data: { b64_json: P } }],
    ['inside a string of text', { data: [{ text: `here: "b64_json":"${P}"` }] }],
    ['invalid base64 (length)', { data: [{ b64_json: P + 'A' }] }],
    ['invalid base64 (= mid-string)', { data: [{ b64_json: P.slice(0, 100) + '=' + P.slice(101) }] }],
    ['invalid base64 (url-safe chars)', { data: [{ b64_json: withK(img('png').replace(/\+/g, '-').replace(/\//g, '_')) }] }],
  ];
  it.each(cases)('%s (sanitizeJson)', (_n, body) => {
    expect(JSON.stringify(sanitizeJson(body, v()))).not.toContain(K);
  });
  it.each(cases)('%s (SSE)', async (_n, body) => {
    const line = `data: ${JSON.stringify(body)}\n\n`;
    expect(await sse(line)).not.toContain(K);
  });
  it('control: the same payload in data[0].b64_json IS exempt (K survives, documented limitation)', () => {
    expect(JSON.stringify(sanitizeJson({ data: [{ b64_json: P }] }, v()))).toContain(K);
  });
  it('bare base64 in an SSE line is plain text', async () => {
    expect(await sse(`data: ${P}\n\n`)).not.toContain(K);
  });
});
