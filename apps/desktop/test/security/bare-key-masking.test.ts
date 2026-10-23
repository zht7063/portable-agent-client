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
  it('id fields keep even random-looking values (request IDs), but sk- keys are still masked there', () => {
    const v = new AccessTokenVault();
    const out = sanitizeJson({ id: KEY48, request_id: KEY48, requestId: KEY48, trace_id: `sk-${KEY48}` }, v) as Record<string, string>;
    expect(out.id).toBe(KEY48);
    expect(out.request_id).toBe(KEY48);
    expect(out.requestId).toBe(KEY48);
    expect(out.trace_id).not.toContain(KEY48);
  });
  it('option key names are not masked', () => {
    const out = sanitizeJson({ data: [{ key: 'SMTPServer', value: 'smtp.example.com' }] }, new AccessTokenVault());
    expect(out).toEqual({ data: [{ key: 'SMTPServer', value: 'smtp.example.com' }] });
  });
});
