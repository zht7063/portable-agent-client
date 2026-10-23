// Aegis M7: keys glued with - / _ into longer runs, and false-positive probes for common ID shapes.
import { describe, expect, it } from 'vitest';
import { AccessTokenVault, maskString, sanitizeJson } from '../../src/main/proxy/sanitize';

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

  // Provider ids: masked only when the whole id (or a [-_] segment) is a >= 32-char mixed-case random run.
  const probes: [string, string, boolean][] = [
    ['chatcmpl- (29-char mixed tail: whole id 38 chars looks random)', 'chatcmpl-9xYzAbCdEf1234GhIjKl5678M', true],
    ['resp_ (48 hex)', 'resp_67ccd2bed1ec8190b14f964abc0542670bb6a6b452d3795b', false],
    ['msg_ (24 mixed)', 'msg_01XFDUDYJgAACzvnptvVoYEL', false],
    ['call_ (24 mixed)', 'call_Fq2kXz9LmN3pRtVw8YbC4dEh', false],
    ['file- (24 mixed)', 'file-AbC123dEf456GhI789jKl0', false],
    ['run_ (32 mixed tail)', 'run_Fq2kXz9LmN3pRtVw8YbC4dEhJ7sQ1uWa', true],
  ];
  it.each(probes)('%s -> masked=%s', (_n, s, m) => { expect(maskString(s) !== s).toBe(m); });
});
});
