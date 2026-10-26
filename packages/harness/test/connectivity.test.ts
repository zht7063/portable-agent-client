import { describe, expect, it } from 'vitest';
import { chmod, readFile, stat } from 'node:fs/promises';
import { createConnectivity } from '@pac/harness';
import { fixture, CANARY } from './v6-fixture.js';
// In-memory fake servers: no sockets or external network, including in restricted CI sandboxes.
const routes = new Map<string, (req: { url: string; method: string }, res: { writeHead(status: number, headers?: Record<string, string>): void; end(body?: string): void }) => void>();
async function server(handle: (req: { url: string; method: string }, res: { writeHead(status: number, headers?: Record<string, string>): void; end(body?: string): void }) => void) {
  const origin = `http://fake-${routes.size}.invalid`; routes.set(origin, handle); return origin;
}
const fakeFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input)); let status = 200; let headers: Record<string, string> = {}; let body = '';
  const handle = routes.get(url.origin); if (!handle) throw new Error('Unexpected network');
  handle({ url: url.pathname, method: init?.method ?? 'GET' }, { writeHead(s, h = {}) { status = s; headers = h; }, end(b) { body = b ?? ''; } });
  if (status >= 300 && status < 400 && init?.redirect !== 'manual' && headers.Location) return fakeFetch(headers.Location, init);
  return new Response(body, { status, headers });
};
describe('S14 connectivity redirects', () => {
  it.each(['/v1/models', '/api/pricing', '/v1/responses', '/v1/messages'])('refuses %s redirects: B gets zero requests', async (path) => {
    let bHits = 0; let aHits = 0;
    const b = await server((_q, r) => { bHits++; r.end('{}'); });
    const a = await server((q, r) => {
      if (q.url === path) { aHits++; r.writeHead(302, { Location: b + path }); r.end(); }
      else if (q.url === '/api/pricing') r.end('{"success":false}');
      else r.end('{"object":"list","data":[{"id":"test-codex"}]}');
    });
    const s = await fixture(a);
    const c = createConnectivity({ origin: a, ...s, fetch: fakeFetch });
    const id = path === '/v1/messages' ? 'claude' : 'codex';
    const level = path === '/v1/models' ? 'L1' : 'L2';
    let result = await c.test(s.profile, { profileId: s.profile.id, id, level });
    if (result.quoteId) result = await c.test(s.profile, { profileId: s.profile.id, id, level, confirm: true, confirmUnknownCost: true, quoteId: result.quoteId });
    expect(result.state).toBe('redirect-refused'); expect(aHits).toBe(1); expect(bHits).toBe(0);
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });
});
describe('D16 paid confirmation and S18/S19 permissions/leaks', () => {
  it('does no paid work before quote + explicit extra unknown-cost confirmation; no retries', async () => {
    let posts = 0;
    const a = await server((q, r) => { if (q.method === 'POST') { posts++; r.writeHead(429); } r.end('{}'); });
    const s = await fixture(a); const c = createConnectivity({ origin: a, ...s, fetch: fakeFetch });
    const req = { profileId: s.profile.id, id: 'codex' as const, level: 'L2' as const };
    const quote = await c.test(s.profile, req);
    expect(quote).toMatchObject({ state: 'confirmation-required', requestCount: 2, estimatedCost: null }); expect(posts).toBe(0);
    expect((await c.test(s.profile, { ...req, quoteId: quote.quoteId, confirm: true })).state).toBe('confirmation-required'); expect(posts).toBe(0);
    const result = await c.test(s.profile, { ...req, quoteId: quote.quoteId, confirm: true, confirmUnknownCost: true });
    expect(result.state).toBe('rate-limited'); expect(posts).toBe(1);
    await c.test(s.profile, { ...req, quoteId: quote.quoteId, confirm: true, confirmUnknownCost: true }); expect(posts).toBe(1);
  });
  it('L0 compares config fingerprints; private modes verified and widening refused', async () => {
    const s = await fixture();
    const c = createConnectivity({ origin: s.profile.serverUrl, ...s });
    await s.harness.apply('codex', await s.harness.plan('codex', s.profile.id));
    expect((await c.test(s.profile, { profileId: s.profile.id, id: 'codex', level: 'L0' })).state).toBe('ok');
    expect((await stat(s.keys.path)).mode & 0o777).toBe(0o600); expect((await stat(s.keys.dir)).mode & 0o777).toBe(0o700);
    expect((await stat(s.codex.configPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(s.state.path, 'utf8')).not.toContain(CANARY);
    await chmod(s.keys.path, 0o644); await expect(s.keys.get(s.profile.id)).rejects.toThrow(/permissions/);
  });
  it('serializes concurrent provider key/state updates without losing entries', async () => {
    const s = await fixture();
    await Promise.all(['a', 'b'].map((id) => s.keys.set(id, CANARY + id, 'pasted')));
    expect(Object.keys(await s.keys.load()).sort()).toEqual(['a', 'b', 'swift-test']);
    await Promise.all(['a', 'b'].map((id) => s.state.upsertProfile({ ...s.profile, id })));
    expect(Object.keys((await s.state.load()).profiles).sort()).toEqual(['a', 'b', 'swift-test']);
  });
  it('skips paid tests with Claude placeholders without touching the network', async () => {
    const s = await fixture(); let calls = 0;
    const c = createConnectivity({ origin: s.profile.serverUrl, ...s, fetch: async () => { calls++; throw new Error('no network'); } });
    expect((await c.test({ ...s.profile, models: { main: 'claude-main-placeholder' } }, { id: 'claude', profileId: s.profile.id, level: 'L2' })).state).toBe('models-pending'); expect(calls).toBe(0);
  });
  it.each(['a;touch /tmp/pwn', 'a&calc', '../x', 'a'.repeat(33)])('S8 rejects provider id %s', async (id) => {
    const s = await fixture(); await expect(s.keys.set(id, CANARY, 'pasted')).rejects.toThrow();
  });
});
