// Aegis M7: keys glued with - / _ into longer runs, and false-positive probes for common ID shapes.
import { describe, expect, it } from 'vitest';
import { AccessTokenVault, MAX_BARE_RUN, knownSet, maskString, replaceKnown, sanitizeJson } from '../../src/main/proxy/sanitize';

const K = 'Zq7Rw2Lp9Xv4Tm8Nk3Hd6Jf1Bc5Gs0YeQa2Wu7Ir4Ot9Pl3S';
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

  // Provider ids: allowlisted prefixes (ID_PREFIX_RUN) + 8-64 alnum tail are never masked by the heuristic.
  const probes: [string, string, boolean][] = [
    ['chatcmpl- (29-char mixed tail: whole id 38 chars looks random)', 'chatcmpl-9xYzAbCdEf1234GhIjKl5678M', false],
    ['resp_ (48 hex)', 'resp_67ccd2bed1ec8190b14f964abc0542670bb6a6b452d3795b', false],
    ['msg_ (24 mixed)', 'msg_01XFDUDYJgAACzvnptvVoYEL', false],
    ['call_ (24 mixed)', 'call_Fq2kXz9LmN3pRtVw8YbC4dEh', false],
    ['file- (24 mixed)', 'file-AbC123dEf456GhI789jKl0', false],
    ['run_ (32 mixed tail)', 'run_Fq2kXz9LmN3pRtVw8YbC4dEhJ7sQ1uWa', false],
  ];
  it.each(probes)('%s -> masked=%s', (_n, s, m) => { expect(maskString(s) !== s).toBe(m); });
});

describe('ID prefix allowlist does not hide keys', () => {
  const prefixes = ['chatcmpl-', 'cmpl-', 'resp_', 'msg_', 'call_', 'run_', 'step_', 'asst_', 'thread_', 'file-', 'batch_', 'ftjob-', 'toolu_', 'req_', 'msgbatch_'];
  it.each(prefixes)('%s<K> is left alone by the heuristic but a KNOWN K is still masked (JSON + text)', (p) => {
    const s = `${p}${K}`;
    expect(maskString(s)).toBe(s);
    const v = new AccessTokenVault(); v.issue(K);
    expect(JSON.stringify(sanitizeJson({ id: s, message: `failed ${s}` }, v))).not.toContain(K);
    expect(JSON.stringify(sanitizeJson({ id: s, api_key: K }, new AccessTokenVault()))).not.toContain(K);
    expect(maskString(replaceKnown(s, knownSet([K])))).not.toContain(K);
  });
  it.each(prefixes)('%s<id>-<K> / %s<K>_x / prefix with a >64 tail are not exempt', (p) => {
    for (const s of [`${p}abc12345-${K}`, `${p}${K}_${K}`, `${p}${K}${K}`]) expect(maskString(s)).not.toContain(K);
  });
  it('unknown prefixes get the normal checks', () => {
    expect(maskString(`key_${K}`)).not.toContain(K);
    expect(maskString(`chatcmpl${K}`)).not.toContain(K);
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
