import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeServerUrl } from '@pac/core';
import { ConfigStore, toClientConfig } from '../src/main/config-store';
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


describe('S16 fixed desktop origin', () => {
  it('refuses malformed existing config without overwriting it', async () => {
    const path = await tmp();
    await writeFile(path, '{broken');
    await expect(new ConfigStore(path).load()).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe('{broken');
  });
  it('ignores and removes old serverUrl and preserves clipboard settings', async () => {
    const p = await tmp();
    await writeFile(p, JSON.stringify({ version: 2, serverUrl: 'https://old.invalid', clipboardClearSeconds: 12 }));
    const store = new ConfigStore(p);
    expect((await store.load()).serverUrl).toBe('https://api.swift-client.invalid');
    expect(JSON.parse(await readFile(p, 'utf8'))).toEqual({ version: 2, lastServerOrigin: 'https://api.swift-client.invalid', clipboardClearSeconds: 12 });
    expect(() => store.apply(store.defaults(), { serverUrl: 'https://evil.invalid' } as never)).toThrow();
    expect(toClientConfig(store.apply(store.defaults(), { clipboardClearSeconds: 0 })).clipboardClearSeconds).toBe(0);
  });
  it('detects a changed build origin even after the legacy serverUrl was removed', async () => {
    const path = await tmp();
    const first = new ConfigStore(path, 'https://first.invalid');
    await first.load();
    const second = new ConfigStore(path, 'https://second.invalid');
    await second.load();
    expect(second.originChanged).toBe(true);
    expect(toClientConfig(second.defaults())).not.toHaveProperty('lastServerOrigin');
    const again = new ConfigStore(path, 'https://second.invalid');
    await again.load(); expect(again.originChanged).toBe(false);
  });
  it('rejects renderer address fields before invoking any config writer', async () => {
    const t = tmpHarnessHost();
    const cfg = toClientConfig(new ConfigStore(await tmp()).defaults());
    let writes = 0;
    const h = createHandlers({ getCore: () => { throw new Error('no network'); }, getConfig: () => cfg, setConfig: async () => { writes++; return cfg; }, harness: t.host.harness });
    expect(await dispatch(h, 'config:set', { serverUrl: 'https://evil.invalid' } as never)).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(writes).toBe(0);
  });
});
