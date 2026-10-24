import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryTokenStore, createCore, normalizeServerUrl, type SessionView } from '@pac/core';
import { ConfigStore, toClientConfig } from '../src/main/config-store';
import { CoreHost } from '../src/main/core-host';
import { createHandlers, dispatch } from '../src/main/ipc/handlers';
import { tmpHarnessHost } from './harness-fixture';

const DEF = 'http://new-api.test:3000';
const tmp = async () => join(await mkdtemp(join(tmpdir(), 'pa-cfg-')), 'config.json');

describe('normalizeServerUrl', () => {
  it('accepts and normalizes http(s)', () => {
    expect(normalizeServerUrl(' http://new-api.test:3000/ ')).toBe(DEF);
    expect(normalizeServerUrl('https://Api.Example.com/base//')).toBe('https://api.example.com/base');
  });
  it.each(['', 'not a url', 'ftp://x', 'javascript:alert(1)', 'http://u:p@host', 'http://h/?q=1', 'http://h/#x', 'file:///etc/passwd'])('rejects %s', (u) => {
    expect(() => normalizeServerUrl(u)).toThrowError();
  });
});

describe('ConfigStore (no built-in server)', () => {
  it('unconfigured by default; seed only when valid; persists and reloads', async () => {
    const p = await tmp();
    expect(await new ConfigStore(p).load()).toEqual({ version: 2, serverUrl: null });
    expect(await new ConfigStore(p, 'not a url').load()).toEqual({ version: 2, serverUrl: null });
    const s = new ConfigStore(p, DEF);
    const d = await s.load();
    expect(d).toEqual({ version: 2, serverUrl: DEF });
    const next = s.apply(d, { serverUrl: 'https://new.example/' });
    await s.save(next);
    expect(JSON.parse(await readFile(p, 'utf8'))).toEqual({ version: 2, serverUrl: 'https://new.example' });
    expect(await new ConfigStore(p, DEF).load()).toEqual(next);
  });
  it('falls back on corrupt/invalid file; ignores legacy fields', async () => {
    const p = await tmp();
    await writeFile(p, '{not json');
    expect((await new ConfigStore(p).load()).serverUrl).toBeNull();
    await writeFile(p, JSON.stringify({ serverUrl: 'ftp://bad' }));
    expect(await new ConfigStore(p, DEF).load()).toEqual({ version: 2, serverUrl: DEF });
    await writeFile(p, JSON.stringify({ version: 1, serverUrl: 'https://ok.example', defaultMaxTokens: 4096 }));
    expect(await new ConfigStore(p).load()).toEqual({ version: 2, serverUrl: 'https://ok.example' });
  });
  it('apply rejects invalid input; non-HTTPS is accepted but flagged insecure (warn only)', () => {
    const s = new ConfigStore('/nonexistent');
    const d = s.defaults();
    expect(() => s.apply(d, { serverUrl: 'nope' })).toThrowError(/Invalid server URL/);
    expect(toClientConfig(s.apply(d, { serverUrl: 'http://10.0.0.2:3000' }))).toEqual({ serverUrl: 'http://10.0.0.2:3000', insecureTransport: true, clipboardClearSeconds: 30 });
    expect(toClientConfig(s.apply(d, { serverUrl: 'https://a.example' }))).toEqual({ serverUrl: 'https://a.example', insecureTransport: false, clipboardClearSeconds: 30 });
    expect(toClientConfig(d)).toEqual({ serverUrl: null, insecureTransport: false, clipboardClearSeconds: 30 });
  });
});

describe('CoreHost', () => {
  async function host(p: string, tokenStore = new MemoryTokenStore(), seed: string | null = DEF) {
    const views: SessionView[] = [];
    const created: string[] = [];
    const h = await CoreHost.start({
      configStore: new ConfigStore(p, seed ?? undefined),
      tokenStore,
      onSessionChange: (v) => views.push(v),
      createCoreImpl: (o) => { created.push(o.serverUrl); return createCore({ ...o, fetch: async () => new Response('{}', { status: 503 }) }); },
    });
    return { h, views, created, tokenStore };
  }

  it('restores persisted URL on startup', async () => {
    const p = await tmp();
    await writeFile(p, JSON.stringify({ version: 2, serverUrl: 'https://saved.example' }));
    const { h, created } = await host(p);
    expect(h.config()).toEqual({ serverUrl: 'https://saved.example', insecureTransport: false, clipboardClearSeconds: 30 });
    expect(created).toEqual(['https://saved.example']);
    expect(h.core.http.baseUrl).toBe('https://saved.example');
  });

  it('unconfigured: no core until a server is set', async () => {
    const p = await tmp();
    const { h, created, views } = await host(p, new MemoryTokenStore(), null);
    expect(h.configured).toBe(false);
    expect(() => h.core).toThrowError(/No server configured/);
    expect(created).toEqual([]);
    await h.set({ serverUrl: 'https://first.example' });
    expect(h.configured).toBe(true);
    expect(created).toEqual(['https://first.example']);
    expect(views.at(-1)).toMatchObject({ status: 'anonymous', serverUrl: 'https://first.example' });
  });

  it('URL change persists, clears session, recreates core and emits anonymous', async () => {
    const p = await tmp();
    const { h, views, created, tokenStore } = await host(p);
    await h.core.session.establish({ accessToken: 'jwt', accessExpiresAt: 9e9, stored: { serverUrl: DEF, refreshCookie: 'c', userId: 1, username: 'u' } });
    const old = h.core;
    const cfg = await h.set({ serverUrl: 'https://new.example/' });
    expect(cfg).toEqual({ serverUrl: 'https://new.example', insecureTransport: false, clipboardClearSeconds: 30 });
    expect(h.core).not.toBe(old);
    expect(created).toEqual([DEF, 'https://new.example']);
    expect(await tokenStore.load()).toBeNull();
    expect(views.at(-1)).toMatchObject({ status: 'anonymous', serverUrl: 'https://new.example' });
    expect(JSON.parse(await readFile(p, 'utf8')).serverUrl).toBe('https://new.example');
    // old core's listener detached: changes on it no longer reach the UI
    const n = views.length;
    await old.session.clear();
    expect(views.length).toBe(n);
    // restart restores
    expect((await host(p)).h.config().serverUrl).toBe('https://new.example');
  });

  it('same URL keeps core and session', async () => {
    const p = await tmp();
    const { h, created } = await host(p);
    await h.core.session.establish({ accessToken: 'jwt', accessExpiresAt: 9e9, stored: { serverUrl: DEF, refreshCookie: 'c', userId: 1, username: 'u' } });
    const old = h.core;
    await h.set({ serverUrl: DEF + '/' });
    expect(h.core).toBe(old);
    expect(created.length).toBe(1);
    expect(h.core.session.view().status).toBe('authenticated');
  });

  it('invalid URL via IPC returns VALIDATION and changes nothing', async () => {
    const p = await tmp();
    const { h } = await host(p);
    const handlers = createHandlers({ getCore: () => h.core, getConfig: () => h.config(), setConfig: (x) => h.set(x), harness: tmpHarnessHost().host.harness, confirmServerChange: async () => true });
    expect(await dispatch(handlers, 'config:set', { serverUrl: 'javascript:alert(1)' })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(h.config().serverUrl).toBe(DEF);
    await expect(readFile(p, 'utf8')).rejects.toThrow();
    await dispatch(handlers, 'config:set', { serverUrl: 'https://b.example' });
    expect(await dispatch(handlers, 'config:get', {})).toEqual({ ok: true, data: { serverUrl: 'https://b.example', insecureTransport: false, clipboardClearSeconds: 30 } });
  });

  it('Aegis #1: renderer server change needs native confirmation (absent or Cancel = refused, nothing saved)', async () => {
    const p = await tmp();
    const { h } = await host(p);
    const asked: [string, string | null][] = [];
    let answer = false;
    const deps = { getCore: () => h.core, getConfig: () => h.config(), setConfig: (x: { serverUrl?: string }) => h.set(x), harness: tmpHarnessHost().host.harness };
    const none = createHandlers(deps);
    expect(await dispatch(none, 'config:set', { serverUrl: 'https://evil.example' })).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    const withDialog = createHandlers({ ...deps, confirmServerChange: async (n, c) => { asked.push([n, c]); return answer; } });
    expect(await dispatch(withDialog, 'config:set', { serverUrl: 'https://evil.example/x' })).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    expect(asked).toEqual([['https://evil.example/x', DEF]]); // full URL shown
    expect(h.config().serverUrl).toBe(DEF);
    await expect(readFile(p, 'utf8')).rejects.toThrow();
    // same server (normalised) -> no prompt
    expect(await dispatch(withDialog, 'config:set', { serverUrl: DEF + '/' })).toMatchObject({ ok: true });
    expect(asked.length).toBe(1);
    answer = true;
    expect(await dispatch(withDialog, 'config:set', { serverUrl: 'https://ok.example' })).toMatchObject({ ok: true, data: { serverUrl: 'https://ok.example' } });
  });
  it.each(['https://user:pass@evil.example', 'https://user@evil.example', 'https://:pw@evil.example', 'http://a%40b:c@x.example/'])('Aegis N3: userinfo URL %s is refused before any dialog', async (u) => {
    const p = await tmp();
    const { h } = await host(p);
    const asked: string[] = [];
    const hs = createHandlers({ getCore: () => h.core, getConfig: () => h.config(), setConfig: (x) => h.set(x), harness: tmpHarnessHost().host.harness, confirmServerChange: async (n) => { asked.push(n); return true; } });
    expect(await dispatch(hs, 'config:set', { serverUrl: u })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(asked).toEqual([]);
    expect(h.config().serverUrl).toBe(DEF);
  });
  it('Aegis N3: server change dialog shows the host on its own line plus the full URL; Cancel default', async () => {
    const { serverChangeDialog } = await import('../src/main/dialogs');
    const d = serverChangeDialog('https://xn--80ak6aa92e.com:8443/api-base', 'https://a.example');
    expect(d.message.split('\n').at(-1)).toBe('xn--80ak6aa92e.com:8443');
    expect(d.detail).toContain('主机：xn--80ak6aa92e.com:8443\n');
    expect(d.detail).toContain('完整地址：https://xn--80ak6aa92e.com:8443/api-base');
    expect([d.defaultId, d.cancelId, d.buttons[0]]).toEqual([0, 0, '取消']);
  });
});
