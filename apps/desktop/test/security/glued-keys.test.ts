// Aegis M7: keys glued with - / _ into longer runs, and false-positive probes for common ID shapes.
import { describe, expect, it } from 'vitest';
import { AccessTokenVault, ID_PREFIX_SHAPES, JsonTooDeepError, MAX_BARE_RUN, knownSet, maskString, replaceKnown, sanitizeJson } from '../../src/main/proxy/sanitize';

const K = 'TestKey0Fake0Not0Real0Dummy0Value000000000000000';
let seed = 3;
const rnd = (n: number, abc: string) => { let o = ''; for (let i = 0; i < n; i++) { seed = (seed * 1103515245 + 12345) >>> 0; o += abc[seed % abc.length]; } return o; };
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const uuid = '3f2b8c1e-9d4a-4e7b-8c21-0a1b2c3d4e5f';
const both = (s: string) => [maskString(s), JSON.stringify(sanitizeJson({ message: s, data: { detail: s } }, new AccessTokenVault()))];

describe('glued keys are masked (maskString + sanitizeJson)', () => {
  const cases: [string, string][] = [
    ['<uuid>-K', `${uuid}-${K}`],
    ['<UUID>-K', `${uuid.toUpperCase()}-${K}`],
    ['K_<100 chars>', `${K}_${'a'.repeat(100)}`],
    ['K_<100 mixed>', `${K}_${rnd(100, 'abcdefghijklmnopqrstuvwxyz0123456789')}`],
    ['/v1/tokens/K-<90 base64url>', `/v1/tokens/${K}-${rnd(90, B64URL)}`],
    ['req-<90 digits>-K failed', `req-${rnd(90, '0123456789')}-${K} failed`],
    ['<200 a>-K-<200 b>', `${'a'.repeat(200)}-${K}-${'b'.repeat(200)}`],
  ];
  it.each(cases)('%s', (_n, s) => { for (const o of both(s)) expect(o).not.toContain(K); });
});

describe('false-positive probes (pinned; ordinary IDs stay readable)', () => {
  const unchanged: [string, string][] = [
    ['lowercase uuid', uuid],
    ['uuid with lowercase suffix', `${uuid}-retry_2`],
    ['request id (digits)', `20261024051400123456789012345678`],
    ['request id (hex)', 'req_8f3a2b1c9d4e5f6a7b8c9d0e1f2a3b4c'],
    ['snake identifier', 'ordinary_snake_case_identifier_with_many_words_v2'],
    ['kebab identifier', 'ordinary-kebab-case-identifier-with-many-words-v2'],
    ['camel identifier', 'getUserSubscriptionPlanForBillingPeriod2'],
    ['CONSTANT', 'MAX_RETRY_COUNT_FOR_UPSTREAM_CHANNEL_REQUESTS_2'],
    ['file- lowercase', 'file-abc123def456ghi789jkl012mno345'],
    ['run_ lowercase', 'run_abc123def456ghi789jkl012mno345'],
    ['model name', 'gemini-2.5-flash-preview-05-20'],
  ];
  it.each(unchanged)('%s unchanged', (_n, s) => { expect(maskString(s)).toBe(s); });

  // Provider ids: only exact per-prefix shapes (ID_PREFIX_SHAPES) are exempt from the heuristic.
  const probes: [string, string, boolean][] = [
    ['chatcmpl- (29 base62)', 'chatcmpl-9xYzAbCdEf1234GhIjKl5678MnOpQ', false],
    ['resp_ (48 hex)', 'resp_67ccd2bed1ec8190b14f964abc0542670bb6a6b452d3795b', false],
    ['msg_ (01 + 22)', 'msg_01XFDUDYJgAACzvnptvVoYEL', false],
    ['call_ (24 mixed)', 'call_Fq2kXz9LmN3pRtVw8YbC4dEh', false],
    ['file- (22 mixed)', 'file-AbC123dEf456GhI789jK', false],
    ['run_ (32 mixed tail: not a real run_ shape -> heuristic applies)', 'run_Fq2kXz9LmN3pRtVw8YbC4dEhJ7sQ1uWa', true],
  ];
  it.each(probes)('%s -> masked=%s', (_n, s, m) => { expect(maskString(s) !== s).toBe(m); });
});

// Deterministic PRNG so failures are reproducible.
const rng = (seed: number) => () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x80000000; };
const A62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const HEX = '0123456789abcdef';
const pick = (r: () => number, a: string, n: number) => { let o = ''; for (let i = 0; i < n; i++) o += a[Math.floor(r() * a.length)]; return o; };
/** A random 48-char base62 key with upper+lower+digit and many class switches (new-api token shape). */
const key48 = (r: () => number) => { for (;;) { const k = pick(r, A62, 48); if (/[a-z]/.test(k) && /[A-Z]/.test(k) && /[0-9]/.test(k) && maskString(k) !== k) return k; } };

describe('ID prefix allowlist: exact per-prefix shapes', () => {
  const synth: Record<string, (r: () => number) => string> = {
    'chatcmpl-': (r) => 'chatcmpl-' + pick(r, A62, 29 + Math.floor(r() * 3)),
    'cmpl-': (r) => 'cmpl-' + pick(r, A62, 29),
    'msgbatch_': (r) => 'msgbatch_01' + pick(r, A62, 22),
    'resp_': (r) => 'resp_' + pick(r, HEX, 48),
    'msg_': (r) => (r() < 0.5 ? 'msg_01' + pick(r, A62, 22) : 'msg_' + pick(r, A62, 24)),
    'toolu_': (r) => 'toolu_01' + pick(r, A62, 21 + Math.floor(r() * 4)),
    'call_': (r) => 'call_' + pick(r, A62, 24),
    'asst_': (r) => 'asst_' + pick(r, A62, 17 + Math.floor(r() * 8)),
    'thread_': (r) => 'thread_' + pick(r, A62, 24),
    'run_': (r) => 'run_' + pick(r, A62, 24),
    'step_': (r) => 'step_' + pick(r, A62, 24),
    'file-': (r) => 'file-' + pick(r, A62, 22 + Math.floor(r() * 3)),
  };
  it('table and synthetic generators cover the same prefixes', () => {
    expect(ID_PREFIX_SHAPES.map((x) => x.prefix).sort()).toEqual(Object.keys(synth).sort());
  });
  it.each(ID_PREFIX_SHAPES.map((x) => [x.prefix, x.example] as const))('%s example %s matches its shape and is unchanged', (p, ex) => {
    expect(ID_PREFIX_SHAPES.find((x) => x.prefix === p)!.re.test(ex)).toBe(true);
    expect(maskString(ex)).toBe(ex);
    expect(maskString(`id=${ex}, next`)).toBe(`id=${ex}, next`);
  });
  it.each(Object.keys(synth))('%s: 200 synthetic real-shape ids -> 0 masked', (p) => {
    const r = rng(p.length * 7919); let masked = 0;
    for (let i = 0; i < 200; i++) { const id = synth[p]!(r); if (maskString(id) !== id) masked++; }
    expect(masked).toBe(0);
  });
  it.each(ID_PREFIX_SHAPES.map((x) => x.prefix))('%s + unknown 48-char key -> masked 15/15', (p) => {
    const r = rng(p.charCodeAt(0) * 31 + p.length); let masked = 0;
    for (let i = 0; i < 15; i++) {
      const k = key48(r);
      const outs = [maskString(`${p}${k}`), maskString(`error: ${p}${k} rejected`), JSON.stringify(sanitizeJson({ id: `${p}${k}` }, new AccessTokenVault()))];
      if (outs.every((o) => !o.includes(k))) masked++;
    }
    expect(masked).toBe(15);
  });
  it.each(ID_PREFIX_SHAPES.map((x) => x.prefix))('%s + KNOWN key is exact-replaced (JSON + text)', (p) => {
    const s = `${p}${K}`;
    const v = new AccessTokenVault(); v.issue(K);
    expect(JSON.stringify(sanitizeJson({ id: s, message: `failed ${s}` }, v))).not.toContain(K);
    expect(JSON.stringify(sanitizeJson({ id: s, api_key: K }, new AccessTokenVault()))).not.toContain(K);
    expect(maskString(replaceKnown(s, knownSet([K])))).not.toContain(K);
  });
  it.each(ID_PREFIX_SHAPES.map((x) => x.prefix))('%s<id>-<K> / %s<K>_x / double K are not exempt', (p) => {
    for (const s of [`${p}abc12345-${K}`, `${p}${K}_${K}`, `${p}${K}${K}`]) expect(maskString(s)).not.toContain(K);
  });
  it('wrong-length tails of the restored prefixes are not exempt', () => {
    const r = rng(42);
    for (const id of ['chatcmpl-' + pick(r, A62, 28), 'chatcmpl-' + pick(r, A62, 32), 'cmpl-' + pick(r, A62, 30), 'msgbatch_01' + pick(r, A62, 23), 'msgbatch_' + pick(r, A62, 24)])
      expect(ID_PREFIX_SHAPES.some((x) => x.re.test(id)), id).toBe(false);
  });
  it('removed / unknown prefixes get the normal checks', () => {
    for (const p of ['batch_', 'ftjob-', 'req_', 'key_', 'chatcmpl']) expect(maskString(`${p}${K}`)).not.toContain(K);
  });
});

describe('linear bare-run scanner', () => {
  it('16.4M-char single run: no stack overflow, masked entirely, fast', () => {
    const big = 'aB3'.repeat(5_466_667); // 16.4M chars
    const t = Date.now();
    const out = maskString(`x ${big} y`);
    expect(Date.now() - t).toBeLessThan(5000);
    expect(out.length).toBeLessThan(100);
    expect(out.startsWith('x aB3a') && out.endsWith(' y')).toBe(true);
  });
  it('16.4M chars of many short runs: linear, unchanged', () => {
    const s = 'hello world. '.repeat(1_262_000);
    const t = Date.now();
    expect(maskString(s)).toBe(s);
    expect(Date.now() - t).toBeLessThan(5000);
  });
  it('run of exactly MAX_BARE_RUN is analysed per segment; one more char masks it whole', () => {
    const at = (n: number) => `${K}-${'a'.repeat(n - K.length - 1)}`;
    const a = maskString(at(MAX_BARE_RUN));
    expect(a).not.toContain(K); expect(a.length).toBeGreaterThan(MAX_BARE_RUN - 100);
    expect(maskString(at(MAX_BARE_RUN + 1)).length).toBeLessThan(40);
  });
});

describe('large / deep inputs do not overflow the stack (Aegis 6)', () => {
  it('deeply nested JSON (100k levels) -> JsonTooDeepError, not RangeError; 256 levels are fine', () => {
    const deep = JSON.parse('['.repeat(100_000) + ']'.repeat(100_000));
    expect(() => sanitizeJson(deep, new AccessTokenVault())).toThrow(JsonTooDeepError);
    const deepSetting = { setting: '{"a":'.repeat(100_000) + '1' + '}'.repeat(100_000) };
    expect(() => sanitizeJson(deepSetting, new AccessTokenVault())).toThrow(JsonTooDeepError);
    const ok = JSON.parse('['.repeat(200) + `"${K}"` + ']'.repeat(200));
    expect(JSON.stringify(sanitizeJson(ok, new AccessTokenVault()))).not.toContain(K);
  });
  it('multi-MB inputs through every masker (eyJ run, sk- run, Bearer run, data:image, b64_json) complete', () => {
    const n = 16 << 20;
    for (const s of [`eyJ${'a'.repeat(n)}`, `sk-${'A1b'.repeat(n / 3)}`, `Bearer ${'Ab1+'.repeat(n / 4)}`, `data:image/png;base64,${'A'.repeat(n)}`, `x ${'Ab1/'.repeat(n / 4)} y`]) {
      expect(() => maskString(s)).not.toThrow();
    }
    expect(() => sanitizeJson({ data: [{ b64_json: 'iVBORw0KGgo' + 'A'.repeat(8 << 20) + 'A' }] }, new AccessTokenVault())).not.toThrow();
  });
});
