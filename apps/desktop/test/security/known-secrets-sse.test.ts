// Aegis M7 (review of 5c417bd): 1a known-value masking everywhere (incl. forged data:image), 2 masked-save guard for
// base64-ish secret fields, 3 SSE line-wise sanitising.
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { CookieJar } from '../../src/main/proxy/cookie-jar';
import { AccessTokenVault, HANDLE_PREFIX, MIN_KNOWN, knownSet, maskString, replaceKnown, sanitizeJson, sseSanitizer, SSE_TOO_LARGE_FRAME, SSE_BUFFER_LIMIT_FRAME, SSE_MAX_BUFFERED, SSE_MAX_STREAM_BUFFERED, SSE_IDLE_MS, SSE_IDLE_TIMEOUT_FRAME, SseBudget, sseBudget, isPemPublicKey } from '../../src/main/proxy/sanitize';
import { ServerProxy } from '../../src/main/proxy/api-proxy';
import { evaluateStatus } from '../../src/main/proxy/server-status';

const ORIGIN = 'https://na.example.test';
const K = 'TestKey0Fake0Not0Real0Dummy0Value000000000000000'; // 48-char key-shaped secret
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
    const t = sseSanitizer([], { maxLine: 1000, maxText: 1000 });
    const enc = new TextEncoder();
    const rs = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode('data: ok\n')); for (let i = 0; i < 5; i++) c.enqueue(enc.encode(`x${K}`.repeat(10))); c.close(); } });
    const out = await new Response(rs.pipeThrough(t)).text();
    expect(out).toBe(`data: ok\n${SSE_TOO_LARGE_FRAME}`);
  });
  it('text (non-image) lines are limited to 1 MiB; image lines get 32 MiB', async () => {
    const ok = `data: {"delta":"${'a '.repeat(450_000)}"}\n\n`; // ~900 KB
    expect(await run(chunked(ok, 7000))).toBe(ok);
    const big = `data: {"delta":"${'a '.repeat(600_000)}"}\n\n`; // ~1.2 MB text
    expect(await run(chunked(big, 7000))).toBe(SSE_TOO_LARGE_FRAME);
    const unterminated = `data: ${'a '.repeat(600_000)}`;
    expect(await run(chunked(unterminated, 7000))).toBe(SSE_TOO_LARGE_FRAME);
    const img = `data: {"data":[{"b64_json":"${bigImage(2)}"}]}\n\n`; // ~2.8 MB, marker split across chunks (101-char chunks)
    const out = await run(chunked(img, 101));
    expect(out).toBe(img);
    const durl = `data: {"url":"data:image/png;base64,${bigImage(2)}"}\n\n`;
    expect(await run(chunked(durl, 9000))).toBe(durl);
  });
  /** Pull-based source: counts how much the sanitizer actually consumed before it gave up. */
  const pulled = async (gen: (i: number) => string | null) => {
    const enc = new TextEncoder(); let i = 0; let consumed = 0;
    const rs = new ReadableStream<Uint8Array>({
      pull(c) { const x = gen(i++); if (x === null) { c.close(); return; } consumed += x.length; c.enqueue(enc.encode(x)); },
    }, { highWaterMark: 0 });
    const out = await new Response(rs.pipeThrough(sseSanitizer([]))).text();
    return { out, consumed };
  };
  const CH = 64 << 10;
  it('fake marker (no image header), 32 MiB line: rejected after ~1 MiB, not after buffering 32 MiB', async () => {
    const head = 'data: {"data":[{"b64_json":"';
    const { out, consumed } = await pulled((i) => (i === 0 ? head : i * CH > (32 << 20) ? null : 'A'.repeat(CH)));
    expect(out).toBe(SSE_TOO_LARGE_FRAME);
    expect(consumed).toBeLessThan((1 << 20) + 2 * CH);
  });
  it('marker on a non-JSON line, or a real image marker after the 8 KiB window, does not promote', async () => {
    const img = bigImage(2);
    for (const head of [`data: "b64_json":"`, `event: x "b64_json":"`, `data: {"pad":"${'p'.repeat(9000)}","data":[{"b64_json":"`]) {
      const { out, consumed } = await pulled((i) => (i === 0 ? head : i * CH > img.length ? null : img.slice((i - 1) * CH, i * CH)));
      expect(out).toBe(SSE_TOO_LARGE_FRAME);
      expect(consumed).toBeLessThan((1 << 20) + 2 * CH + head.length);
    }
  });
  it('text outside a verified image span is still limited to ~1 MiB on an image line', async () => {
    const line = `data: {"data":[{"b64_json":"${bigImage(1)}","note":"${'t'.repeat(1_100_000)}"}]}\n\n`;
    expect(await run(chunked(line, CH))).toBe(SSE_TOO_LARGE_FRAME);
  });
  it('two real images on one line (b64_json and data:image) pass byte-identical', async () => {
    const line = `data: {"data":[{"b64_json":"${bigImage(2)}"},{"b64_json":"${bigImage(1)}","url":"data:image/png;base64,${bigImage(1)}"}]}\n\ndata: [DONE]\n\n`;
    expect(await run(chunked(line, 7777))).toBe(line);
  });
  it('default global buffer cap is 64 MiB and the shared counter is 0 at rest', () => {
    expect(SSE_MAX_BUFFERED).toBe(64 << 20); expect(sseBudget.limit).toBe(64 << 20); expect(sseBudget.held).toBe(0);
  });
  it('concurrent streams: the one overflowing the global budget errors, the others continue', async () => {
    const enc = new TextEncoder(); const budget = new SseBudget(10_000);
    const mk = () => { let c!: ReadableStreamDefaultController<Uint8Array>; const rs = new ReadableStream<Uint8Array>({ start(x) { c = x; } }); return { c, out: new Response(rs.pipeThrough(sseSanitizer([], {}, budget))).text() }; };
    const a = mk(), b = mk(), z = mk();
    a.c.enqueue(enc.encode('data: {"x":"' + 'a'.repeat(4000)));   // A holds ~4 KB partial
    b.c.enqueue(enc.encode('data: {"x":"' + 'b'.repeat(4000)));   // B holds ~4 KB partial
    await new Promise((r) => setTimeout(r, 0));
    expect(budget.held).toBeGreaterThan(8000);
    z.c.enqueue(enc.encode('data: {"x":"' + 'c'.repeat(4000)));   // Z would exceed 10 KB -> errors
    await new Promise((r) => setTimeout(r, 0));
    expect(await z.out).toBe(SSE_BUFFER_LIMIT_FRAME);
    expect(budget.held).toBeLessThanOrEqual(10_000);
    a.c.enqueue(enc.encode('"}\n\n')); b.c.enqueue(enc.encode('"}\n\n')); a.c.close(); b.c.close();
    expect(await a.out).toBe('data: {"x":"' + 'a'.repeat(4000) + '"}\n\n');
    expect(await b.out).toBe('data: {"x":"' + 'b'.repeat(4000) + '"}\n\n');
    expect(budget.held).toBe(0);
  });
  it('long stream with cumulative bytes >> cap but small buffered lines passes (no per-stream total cap)', async () => {
    const enc = new TextEncoder(); const budget = new SseBudget(1000);
    const line = 'data: {"delta":"' + 'h'.repeat(100) + '"}\n\n';
    const rs = new ReadableStream<Uint8Array>({ start(c) { for (let i = 0; i < 2000; i++) { c.enqueue(enc.encode(line.slice(0, 50))); c.enqueue(enc.encode(line.slice(50))); } c.close(); } });
    const out = await new Response(rs.pipeThrough(sseSanitizer([], {}, budget))).text();
    expect(out).toBe(line.repeat(2000)); expect(out.length).toBeGreaterThan(200_000); expect(budget.held).toBe(0);
  });
  it('counter returns to 0 after consumer cancel and upstream error', async () => {
    const enc = new TextEncoder(); const budget = new SseBudget(1 << 20);
    // consumer cancel
    let c1!: ReadableStreamDefaultController<Uint8Array>;
    const r1 = new ReadableStream<Uint8Array>({ start(x) { c1 = x; } }).pipeThrough(sseSanitizer([], {}, budget)).getReader();
    void r1.read().catch(() => undefined);   // pull so the transform runs
    c1.enqueue(enc.encode('data: {"x":"' + 'q'.repeat(5000)));
    await new Promise((r) => setTimeout(r, 0));
    expect(budget.held).toBeGreaterThan(5000);
    await r1.cancel(); await new Promise((r) => setTimeout(r, 0));
    expect(budget.held).toBe(0);
    // upstream error (abort)
    let c2!: ReadableStreamDefaultController<Uint8Array>;
    const r2 = new Response(new ReadableStream<Uint8Array>({ start(x) { c2 = x; } }).pipeThrough(sseSanitizer([], {}, budget))).text();
    c2.enqueue(enc.encode('data: {"x":"' + 'w'.repeat(5000)));
    await new Promise((r) => setTimeout(r, 0));
    expect(budget.held).toBeGreaterThan(5000);
    c2.error(new Error('upstream reset'));
    await expect(r2).rejects.toThrow();
    expect(budget.held).toBe(0);
    // line-too-large error path
    const r3 = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode('data: {"x":"' + 'e'.repeat(3000))); c.close(); } });
    expect(await new Response(r3.pipeThrough(sseSanitizer([], { maxLine: 1000, maxText: 1000 }, budget))).text()).toBe(SSE_TOO_LARGE_FRAME);
    expect(budget.held).toBe(0);
  });
  // --- Aegis review 12 ---
  it('promotion uses the exact b64_json / data:image predicates: structurally-marked but invalid images -> SSE_LINE_TOO_LARGE', async () => {
    const img = bigImage(2);
    const bad = [
      `data: {"x":{"data":[{"b64_json":"${img}"}]}}\n\n`,                 // nested, not top-level data[i]
      `data: {"data":{"b64_json":"${img}"}}\n\n`,                         // data is not an array
      `data: {"data":[{"b64_json":"${img}A"}]}\n\n`,                      // length % 4 != 0 (meter passes, predicate fails)
      `data: {"data":[{"b64_json":"${img.slice(0, -4)}====" }]}\n\n`,     // bad padding
      `data: {"data":[{"b64_json":"${img}", "x":1]}\n\n`,                // not JSON
      `data: {"u":"data:image/png;base64,${img}A"}\n\n`,                  // data:image fails validB64
    ];
    for (const line of bad) {
      const t0 = Date.now();
      expect(await run(chunked(line, CH))).toBe(SSE_TOO_LARGE_FRAME);
      expect(Date.now() - t0).toBeLessThan(5000);
    }
  });
  it('an image span containing a known value is not promoted (-> SSE_LINE_TOO_LARGE, value never emitted)', async () => {
    const img = bigImage(2); const k = img.slice(500_000, 500_048);
    const out = await run(chunked(`data: {"data":[{"b64_json":"${img}"}]}\n\n`, CH), [k]);
    expect(out).toBe(SSE_TOO_LARGE_FRAME);
  });
  it('valid top-level b64_json and data:image lines > 1 MiB still pass byte-identical', async () => {
    const a = `data: {"data":[{"b64_json":"${bigImage(2)}","revised_prompt":"x"}]}\n\n`;
    expect(await run(chunked(a, CH))).toBe(a);
    const b = `data: {"choices":[{"delta":{"content":"![](data:image/png;base64,${bigImage(2)})"}}]}\n\n`;
    expect(await run(chunked(b, CH))).toBe(b);
  });
  it('counter returns to 0 when sanitising throws (try/finally)', async () => {
    const budget = new SseBudget(1 << 20); const enc = new TextEncoder();
    const boom = new Proxy([] as string[], { get(t, k) { if (k === Symbol.iterator) throw new Error('boom'); return Reflect.get(t, k); } });
    const rs = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode('data: {"x":"' + 'p'.repeat(5000))); c.enqueue(enc.encode('"}\n')); c.close(); } });
    await expect(new Response(rs.pipeThrough(sseSanitizer(boom, {}, budget))).text()).rejects.toThrow('boom');
    expect(budget.held).toBe(0); expect(budget.streams).toBe(0);
  });
  it('global overflow kills the stream with the LARGEST buffered usage, not necessarily the requester', async () => {
    const enc = new TextEncoder(); const budget = new SseBudget(10_000, 9_000);
    const mk = () => { let c!: ReadableStreamDefaultController<Uint8Array>; const rs = new ReadableStream<Uint8Array>({ start(x) { c = x; } }); return { c, out: new Response(rs.pipeThrough(sseSanitizer([], {}, budget))).text() }; };
    const big = mk(), small = mk(), req = mk();
    const tick = () => new Promise((r) => setTimeout(r, 0));
    big.c.enqueue(enc.encode('data: {"x":"' + 'b'.repeat(6000))); await tick();
    small.c.enqueue(enc.encode('data: {"x":"' + 's'.repeat(1000))); await tick();
    req.c.enqueue(enc.encode('data: {"x":"' + 'r'.repeat(3500))); await tick(); // total would be ~10.5k > 10k
    expect(await big.out).toBe(SSE_BUFFER_LIMIT_FRAME);                        // largest killed
    small.c.enqueue(enc.encode('"}\n')); small.c.close(); req.c.enqueue(enc.encode('"}\n')); req.c.close();
    expect(await small.out).toBe('data: {"x":"' + 's'.repeat(1000) + '"}\n');
    expect(await req.out).toBe('data: {"x":"' + 'r'.repeat(3500) + '"}\n');
    expect(budget.held).toBe(0); expect(budget.streams).toBe(0);
  });
  it('per-stream buffered cap (default 32 MiB) -> SSE_BUFFER_LIMIT for that stream only', async () => {
    expect(SSE_MAX_STREAM_BUFFERED).toBe(32 << 20); expect(sseBudget.perStream).toBe(32 << 20);
    const enc = new TextEncoder(); const budget = new SseBudget(1 << 20, 2000);
    const rs = new ReadableStream<Uint8Array>({ start(c) { for (let i = 0; i < 5; i++) c.enqueue(enc.encode('data: {"x":"' + 'z'.repeat(500))); c.close(); } });
    expect(await new Response(rs.pipeThrough(sseSanitizer([], {}, budget))).text()).toBe(SSE_BUFFER_LIMIT_FRAME);
    expect(budget.held).toBe(0);
  });
  it('accounting is in UTF-8 bytes (multi-byte text)', async () => {
    const enc = new TextEncoder(); const budget = new SseBudget(1 << 20);
    let c!: ReadableStreamDefaultController<Uint8Array>;
    const r = new ReadableStream<Uint8Array>({ start(x) { c = x; } }).pipeThrough(sseSanitizer([], {}, budget)).getReader();
    void r.read().catch(() => undefined);
    c.enqueue(enc.encode('data: ' + '€'.repeat(1000) + '😀'.repeat(100))); await new Promise((x) => setTimeout(x, 0));
    expect(budget.held).toBe(6 + 3000 + 400);
    await r.cancel(); expect(budget.held).toBe(0);
    // text limit counts bytes too: 400k x 3-byte chars (1.2 MB) > 1 MiB
    expect(await run([`data: ${'€'.repeat(400_000)}\n`])).toBe(SSE_TOO_LARGE_FRAME);
    expect(await run([`data: ${'€'.repeat(300_000)}\n`])).toBe(`data: ${'€'.repeat(300_000)}\n`);
  });
  // --- Aegis re-review of 53453ca ---
  it('idle timeout: a dropped stream (never cancelled) holding a half line releases its bytes and ends', async () => {
    vi.useFakeTimers();
    try {
      expect(SSE_IDLE_MS).toBe(120_000);
      const enc = new TextEncoder(); const budget = new SseBudget(1 << 20);
      let c!: ReadableStreamDefaultController<Uint8Array>;
      const r = new ReadableStream<Uint8Array>({ start(x) { c = x; } }).pipeThrough(sseSanitizer([], { idleMs: 5000 }, budget)).getReader();
      const first = r.read();
      c.enqueue(enc.encode('data: {"x":"' + 'h'.repeat(3000)));
      await vi.advanceTimersByTimeAsync(0);
      expect(budget.held).toBeGreaterThan(3000); expect(budget.streams).toBe(1);
      await vi.advanceTimersByTimeAsync(4000);
      c.enqueue(enc.encode('h'.repeat(10)));                     // activity resets the timer
      await vi.advanceTimersByTimeAsync(4000);
      expect(budget.held).toBeGreaterThan(3000);
      await vi.advanceTimersByTimeAsync(1500);                   // 5 s idle -> ended, released
      expect(budget.held).toBe(0); expect(budget.streams).toBe(0);
      expect(new TextDecoder().decode((await first).value)).toBe(SSE_IDLE_TIMEOUT_FRAME);
      expect((await r.read()).done).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it('idle timer is not armed between complete lines (long quiet sessions are not cut)', async () => {
    vi.useFakeTimers();
    try {
      const enc = new TextEncoder(); const budget = new SseBudget(1 << 20);
      let c!: ReadableStreamDefaultController<Uint8Array>;
      const out = new Response(new ReadableStream<Uint8Array>({ start(x) { c = x; } }).pipeThrough(sseSanitizer([], { idleMs: 5000 }, budget))).text();
      c.enqueue(enc.encode('data: {"a":1}\n\n'));
      await vi.advanceTimersByTimeAsync(60_000);
      c.enqueue(enc.encode('data: {"b":2}\n\n')); c.close();
      expect(await out).toBe('data: {"a":1}\n\ndata: {"b":2}\n\n');
      expect(budget.held).toBe(0); expect(budget.streams).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('budget holds streams weakly: FinalizationRegistry releases a collected stream\'s bytes', async () => {
    const { setFlagsFromString } = await import('node:v8'); const { runInNewContext } = await import('node:vm');
    setFlagsFromString('--expose-gc'); const gc = runInNewContext('gc') as () => void;
    const budget = new SseBudget(1 << 20);
    // Unit-level: a holder registered, charged, then unreachable.
    (() => { const h = { held: 0, kill() {} }; budget.register(h); expect(budget.reserve(h, 4096)).toBe(true); })();
    expect(budget.held).toBe(4096);
    expect(typeof gc).toBe('function');
    for (let i = 0; i < 20 && budget.held > 0; i++) { gc(); await new Promise((r) => setTimeout(r, 10)); }
    expect(budget.held).toBe(0); expect(budget.streams).toBe(0);
  });
  it('a dropped stream with a NON-EMPTY buffer and a pending idle timer is collectable: GC releases its bytes before the timeout', async () => {
    const { setFlagsFromString } = await import('node:v8'); const { runInNewContext } = await import('node:vm');
    setFlagsFromString('--expose-gc'); const gc = runInNewContext('gc') as () => void;
    const budget = new SseBudget(1 << 20);
    await (async () => {
      const enc = new TextEncoder();
      let c: ReadableStreamDefaultController<Uint8Array> | null = null;
      const r = new ReadableStream<Uint8Array>({ start(x) { c = x; } }).pipeThrough(sseSanitizer([], { idleMs: 600_000 }, budget)).getReader();
      void r.read().catch(() => undefined);
      c!.enqueue(enc.encode('data: {"x":"' + 'g'.repeat(8000)));
      await new Promise((x) => setTimeout(x, 0));
      expect(budget.held).toBeGreaterThan(8000); expect(budget.streams).toBe(1);
      c = null;
    })();
    for (let i = 0; i < 50 && budget.held > 0; i++) { gc(); await new Promise((x) => setTimeout(x, 10)); }
    expect(budget.held).toBe(0); expect(budget.streams).toBe(0);
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
  it('a PEM with extra bytes after the key (re-export mismatch) is not exempt', () => {
    const der = kp.publicKey.export({ type: 'spki', format: 'der' });
    const pem = (b: Buffer) => `-----BEGIN PUBLIC KEY-----\n${b.toString('base64').replace(/.{64}/g, '$&\n')}\n-----END PUBLIC KEY-----\n`;
    expect(isPemPublicKey(pem(der))).toBe(true);
    for (const extra of [Buffer.from(K), Buffer.from([0]), Buffer.alloc(36, 0x41)]) expect(isPemPublicKey(pem(Buffer.concat([der, extra])))).toBe(false);
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
