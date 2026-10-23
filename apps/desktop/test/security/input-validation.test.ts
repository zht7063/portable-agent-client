/* M7: path traversal fuzz, masked admin saves, server URL validation. Deterministic (seeded) fuzzing. */
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { normalizeServerUrl } from '@pac/core';
import { ControlledFs, nodeFsOps } from '@pac/core/fs';
import { normalisePath } from '../../src/main/proxy/allowlist';
import { resolveRequest } from '../../src/main/app-protocol';
import { ServerProxy, MASKED_SAVE_MESSAGE, containsMaskedValue, containsMaskedPassword } from '../../src/main/proxy/api-proxy';
import { CookieJar } from '../../src/main/proxy/cookie-jar';
import { AccessTokenVault, maskSecret } from '../../src/main/proxy/sanitize';
import { evaluateStatus, type CompatRange } from '../../src/main/proxy/server-status';

/** Small deterministic PRNG (mulberry32) so failures are reproducible. */
function rng(seed: number) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const ATOMS = ['..', '.', '%2e%2e', '%2E%2E', '%2e.', '.%2e', '%252e%252e', '..%2f', '..%5c', '%2f', '%5c', '\\', '%00', '\0', '//', '/', 'api', 'v1', 'etc', 'passwd', 'index.html', 'assets', 'x.js', '%c0%ae%c0%ae', '..;', '%u002e', '....', ' ..', '.. ', '~', '%7e', '?', '#', ';', '%3f', 'C:', 'c:\\windows'];
function fuzzPaths(n: number, seed = 7): string[] {
  const r = rng(seed); const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const len = 1 + Math.floor(r() * 6);
    out.push('/' + Array.from({ length: len }, () => ATOMS[Math.floor(r() * ATOMS.length)]).join(r() < 0.8 ? '/' : ''));
  }
  return out;
}
const fixed = ['/../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd', '/assets/..%2f..%2fetc/passwd', '/assets/%2e%2e/%2e%2e/x', '/..\\..\\x', '/%5c..%5cx',
  '/assets/%252e%252e/x', '/a/./b', '/%00', '/x%00.js', '//evil.test/x', '/api/../../x', '/api/%2e%2e/x', '/C:/Windows/win.ini'];

describe('path traversal fuzz', () => {
  const root = resolve('/srv/renderer');
  it('app protocol never resolves a file outside the renderer root (fixed + 3000 fuzzed paths)', () => {
    for (const p of [...fixed, ...fuzzPaths(3000)]) {
      let url: string; try { url = new URL(`pac://app${p}`).href; } catch { continue; }
      const r = resolveRequest(url, root, 'pac');
      if (r.kind === 'file') {
        const rel = relative(root, r.path);
        expect(rel.startsWith('..') || isAbsolute(rel), `${p} -> ${r.path}`).toBe(false);
      }
    }
    // Raw and %2e-encoded dot segments are collapsed by the URL parser (stay inside root); encoded traversal/separators must be rejected.
    for (const p of fixed.filter((x) => /%00|%5c|%2f|\\/i.test(x)))
      expect(resolveRequest(`pac://app${p}`, root, 'pac').kind, p).toBe('reject');
  });
  it('proxy path normalisation never lets a dot segment or encoded separator through (fixed + 3000 fuzzed)', () => {
    for (const p of [...fixed, ...fuzzPaths(3000, 11)]) {
      let pathname: string; try { pathname = new URL(`pac://app${p}`).pathname; } catch { continue; }
      const n = normalisePath(pathname);
      if (n === null) continue;
      expect(n.split('/').some((s) => s === '..' || s === '.'), p).toBe(false);
      expect(/%2f|%5c|%00|%2e|\\|\0/i.test(n), p).toBe(false);
      expect(n.startsWith('//'), p).toBe(false);
      expect(new URL(n, 'https://server.test').origin).toBe('https://server.test');
    }
  });
  it('harness controlled fs refuses paths outside its roots, incl. via symlinks', async () => {
    const base = mkdtempSync(join(tmpdir(), 'pa-fuzz-'));
    const home = join(base, 'home'); mkdirSync(join(home, '.codex'), { recursive: true }); mkdirSync(join(base, 'outside'));
    symlinkSync(join(base, 'outside'), join(home, '.codex', 'link'));
    const fs = new ControlledFs({ ops: nodeFsOps, roots: [home], dataDir: join(home, '.pa') });
    for (const p of [join(home, '..', 'outside', 'x'), join(home, '.codex', 'link', 'x'), '/etc/passwd', 'relative/x', `${home}/../${'..'}/x`, join(home, '.codex', '..', '..', 'outside')])
      await expect(fs.assertAllowed(p), p).rejects.toThrow();
    await expect(fs.assertAllowed(join(home, '.codex', 'config.toml'))).resolves.toBe(join(home, '.codex', 'config.toml'));
  });
});

describe('masked admin saves', () => {
  const COMPAT: CompatRange = { tag: 'v1.0.0-rc.46', minServer: 'v1.0.0-rc.46', maxServerTested: null, policy: 'same-minor-line' };
  const ORIGIN = 'https://na.example.test';
  const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
  function proxy() {
    const fetch = vi.fn(async () => Response.json({ success: true }));
    const p = new ServerProxy({ getOrigin: () => ORIGIN, getCheck: () => evaluateStatus(COMPAT, ORIGIN, { success: true, data: { version: 'v1.0.0-rc.46' } }), getJar: () => new CookieJar(), vault: new AccessTokenVault(), fetch });
    return { fetch, req: (m: string, path: string, body: string) => p.handle({ method: m, url: `pac://app${path}`, headers: new Headers({ 'content-type': 'application/json' }), body: enc(body) }) };
  }
  const masks = [maskSecret('sk-' + 'A'.repeat(48)), maskSecret('0123456789abcdef'), 'ab****yz', 'pac-h.abcdef']; // all-star masks of <= 4 chars ('****') are ambiguous by design (see api-proxy MASK_SHORT)
  const adminPaths = ['/api/channel/', '/api/channel/12', '/api/option/', '/api/custom-oauth-provider/', '/api/custom-oauth-provider/3', '/api/deployments/x', '/api/channel/'];
  it.each(['POST', 'PUT', 'PATCH'])('%s with any masked value in any position on admin secret paths -> 409, not forwarded', async (m) => {
    for (const path of adminPaths) for (const v of masks) for (const body of [
      JSON.stringify({ key: v }), JSON.stringify({ nested: { deep: [{ client_secret: v }] } }), JSON.stringify({ key: 'X', value: JSON.stringify({ s: v }) }), `key=${encodeURIComponent(v)}`,
    ]) {
      const { fetch, req } = proxy();
      const r = await req(m, path, body);
      expect(r.status, `${m} ${path} ${body}`).toBe(409);
      expect(((await r.json()) as { message: string }).message).toBe(MASKED_SAVE_MESSAGE);
      expect(fetch).not.toHaveBeenCalled();
    }
  });
  it('trailing-slash / case variants of admin paths are covered; GET/DELETE are not bodies to protect', async () => {
    const { fetch, req } = proxy();
    expect((await req('PUT', '/api/option', JSON.stringify({ key: 'K', value: masks[0] }))).status).toBe(409);
    expect((await req('PUT', '/api/channel', JSON.stringify({ key: masks[2] }))).status).toBe(409);
    expect((await req('DELETE', '/api/channel/1', '')).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('detectors: masked values vs. legitimate stars', () => {
    for (const v of masks) expect(containsMaskedValue(enc(JSON.stringify({ a: v }))), v).toBe(true);
    for (const v of ['*', '**', 'a*b', '*.example.com', 'abc', '']) expect(containsMaskedValue(enc(JSON.stringify({ a: v }))), v).toBe(false);
    expect(containsMaskedPassword(enc(JSON.stringify({ password: masks[0] })))).toBe(true);
    expect(containsMaskedPassword(enc(JSON.stringify({ password: 'hunter2', display_name: masks[0] })))).toBe(false);
  });
});

describe('server URL validation', () => {
  it.each([
    ['https://api.example.com', 'https://api.example.com'], ['https://api.example.com/', 'https://api.example.com'],
    ['  https://api.example.com/base/  ', 'https://api.example.com/base'], ['http://127.0.0.1:3000', 'http://127.0.0.1:3000'],
    ['HTTPS://API.EXAMPLE.COM', 'https://api.example.com'], ['https://[::1]:8443/', 'https://[::1]:8443'],
  ])('accepts %s -> %s', (i, o) => { expect(normalizeServerUrl(i)).toBe(o); });
  it.each([
    '', 'api.example.com', 'ftp://x.test', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'ws://x.test',
    'https://user:pw@x.test', 'https://user@x.test', 'https://x.test/?a=1', 'https://x.test/#f', 'https://', 'pac://app/', 'about:blank',
  ])('rejects %s', (i) => { expect(() => normalizeServerUrl(i)).toThrow(); });
});
