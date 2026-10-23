// M7 (Aegis): false-positive rate of bare-key masking on ordinary base64 (how often a legit blob gets altered).
// 10k deterministic blobs: random / PNG / JPEG / gzip bytes, base64-encoded, unwrapped or wrapped at 64 / 76 cols,
// bare or as a data:image URI. Prints a table (also: PA_B64_BENCH=1 for the per-kind table) and pins upper bounds.
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { maskString } from '../../src/main/proxy/sanitize';

let seed = 0x5eed;
const rnd = () => { // mulberry32 (deterministic)
  let t = (seed = (seed + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
};
const bytes = (n: number) => Buffer.from(Array.from({ length: n }, () => Math.floor(rnd() * 256)));
const HEAD = {
  random: Buffer.alloc(0),
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]),
  jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0]),
};
const wrap = (s: string, w: number) => (w ? s.replace(new RegExp(`(.{${w}})(?=.)`, 'g'), '$1\n') : s);
const bucket = (n: number) => (n < 64 ? '<64' : n < 128 ? '64-127' : n < 512 ? '128-511' : '>=512');

describe('base64 false-positive bench', () => {
  it('ordinary base64 is (almost) never altered by masking', () => {
    const stats = new Map<string, { n: number; alt: number }>();
    const add = (k: string, alt: boolean) => { const v = stats.get(k) ?? { n: 0, alt: 0 }; v.n++; if (alt) v.alt++; stats.set(k, v); };
    for (let i = 0; i < 10_000; i++) {
      const kind = (['random', 'random', 'png', 'jpeg', 'gzip'] as const)[Math.floor(rnd() * 5)]!;
      const n = 8 + Math.floor(rnd() ** 2 * 2400);
      const raw = kind === 'gzip' ? gzipSync(Buffer.concat([Buffer.from('{"log":"'), bytes(n)])) : Buffer.concat([HEAD[kind as 'random'], bytes(n)]);
      const b = raw.toString('base64');
      const w = [0, 0, 64, 76][Math.floor(rnd() * 4)]!;
      const asImage = (kind === 'png' || kind === 'jpeg') && rnd() < 0.34;
      const text = asImage ? `data:image/${kind};base64,${b}` : wrap(b, w);
      const altered = maskString(text) !== text;
      add(`${bucket(b.length)}`, altered);
      add(`${kind}${asImage ? '(data:image)' : w ? `(wrap ${w})` : ''}`, altered);
      add('all', altered);
    }
    const rows = [...stats].map(([k, v]) => `${k.padEnd(22)} ${String(v.n).padStart(5)}  altered ${String(v.alt).padStart(4)}  ${((100 * v.alt) / v.n).toFixed(2)}%`);
    console.info(`base64 FP bench (10k blobs)\n${rows.join('\n')}`);
    const pct = (k: string) => { const v = stats.get(k)!; return (100 * v.alt) / v.n; };
    // measured at commit time: >=512 0.02%, 128-511 0.51%, 64-127 8.33%, <64 36.31% (short blobs are plain text), all 4.59%
    expect(pct('>=512')).toBeLessThanOrEqual(0.5);
    expect(pct('128-511')).toBeLessThanOrEqual(1.5);
    expect(pct('64-127')).toBeLessThanOrEqual(12);
    expect(pct('all')).toBeLessThanOrEqual(6);
  });
});
