import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HarnessHost } from '../src/main/harness-host';
import { createHandlers, dispatch } from '../src/main/ipc/handlers';
import { fixture, CANARY } from '../../../packages/harness/test/v6-fixture';

describe('desktop v6 IPC', () => {
  it('S20 detach removes both projected keys, key file, key-containing snapshots; S19 responses never contain CANARY', async () => {
    const s = await fixture();
    const host = new HarnessHost({ home: s.home, dataDir: s.data, env: s.env.env, platform: 'linux', exec: s.exec, keyFile: s.keys });
    const cfg = { serverUrl: s.profile.serverUrl, insecureTransport: false, clipboardClearSeconds: 30 };
    const h = createHandlers({ harness: host.harness, harnessHost: host, getCore: () => { throw new Error('no network'); }, getConfig: () => cfg, setConfig: async () => cfg });
    const responses: unknown[] = [];
    for (const id of ['codex', 'claude'] as const) {
      const p = await host.harness.plan(id, s.profile.id);
      responses.push(p, await dispatch(h, 'harness:apply', { id, plan: p, confirm: true }));
    }
    responses.push(await dispatch(h, 'harness:rollback', { id: 'codex', target: 'detach', confirm: true }));
    expect(JSON.stringify(responses)).not.toContain(CANARY);
    expect(await readFile(s.codex.configPath, 'utf8')).not.toContain(CANARY);
    expect(await readFile(s.claude.settingsPath, 'utf8')).not.toContain(CANARY);
    await expect(stat(s.keys.path)).rejects.toThrow(); expect((await s.fs.loadBackup('codex', 'first-write')).every((e) => e.data === null || !new TextDecoder().decode(e.data).includes(CANARY))).toBe(true);
    expect(await dispatch(h, 'harness:rollback', { id: 'claude', target: 'detach', confirm: true })).toMatchObject({ ok: true, data: { written: [] } });
  });
  it.each(['serverUrl', 'host', 'origin', 'providerId'])('S7 rejects extra %s before key or network access', async (field) => {
    const root = await mkdtemp(join(tmpdir(), 'swift-ipc-'));
    const host = new HarnessHost({ home: join(root, 'home'), dataDir: join(root, 'data'), env: {}, platform: 'linux', exec: async () => ({ code: null, stdout: '', stderr: '' }) });
    let calls = 0; const cfg = { serverUrl: 'https://api.swift-client.invalid', insecureTransport: false, clipboardClearSeconds: 30 };
    const h = createHandlers({ harness: host.harness, harnessHost: host, getCore: () => { calls++; throw new Error('unexpected'); }, getConfig: () => cfg, setConfig: async () => cfg });
    const req = { label: 'test', keyId: 7, models: { main: 'test' }, [field]: 'https://evil.invalid' };
    expect(await dispatch(h, 'harness:provider:upsert', req as never)).toMatchObject({ ok: false, error: { code: 'VALIDATION' } }); expect(calls).toBe(0);
  });
});
