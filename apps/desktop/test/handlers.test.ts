import { describe, expect, it } from 'vitest';
import { INVOKE_CHANNELS, MemoryKeyVault, MemoryTokenStore, createCore, type ClientConfig } from '@pac/core';
import { createHandlers, dispatch } from '../src/main/ipc/handlers';
import { tmpHarnessHost } from './harness-fixture';

function setup() {
  const vault = new MemoryKeyVault();
  void vault.set(2, 'sk-' + 'A'.repeat(48));
  const core = createCore({ serverUrl: 'http://new-api.test:3000', store: new MemoryTokenStore(), vault, fetch: async () => { throw new Error('no network in tests'); } });
  let cfg: ClientConfig = { serverUrl: 'http://new-api.test:3000', insecureTransport: true };
  const handlers = createHandlers({ getCore: () => core, getConfig: () => cfg, setConfig: async (p) => (cfg = { ...cfg, ...p }), harness: tmpHarnessHost().host.harness });
  return { core, handlers };
}

describe('desktop IPC handlers', () => {
  it('has a handler for every channel; dropped v0 channels are gone', () => {
    const { handlers } = setup();
    expect(Object.keys(handlers).sort()).toEqual([...INVOKE_CHANNELS].sort());
    for (const ch of ['auth:login', 'billing:balance', 'keys:reveal', 'chat:complete', 'models:list']) expect(ch in handlers).toBe(false);
  });
  it('config:get returns Result ok without credentials', async () => {
    const { handlers } = setup();
    expect(await dispatch(handlers, 'config:get', {})).toEqual({ ok: true, data: { serverUrl: 'http://new-api.test:3000', insecureTransport: true } });
  });
  it('module errors map to Result errors', async () => {
    const { handlers } = setup();
    expect(await dispatch(handlers, 'harness:plan', { id: 'pi', profileId: 'nope' })).toMatchObject({ ok: false, error: { code: 'VALIDATION', message: 'Unknown harness profile' } });
  });
  it('blocks responses containing credentials', async () => {
    const { handlers } = setup();
    // @ts-expect-error simulate a buggy handler leaking a key
    handlers['config:get'] = async () => ({ serverUrl: 'x', apiKey: 'sk-' + 'A'.repeat(48) });
    expect(await dispatch(handlers, 'config:get', {})).toMatchObject({ ok: false, error: { code: 'SERVER' } });
  });
  it('unknown and removed channels are rejected', async () => {
    const { handlers } = setup();
    // @ts-expect-error unknown channel
    expect(await dispatch(handlers, 'nope', {})).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    // @ts-expect-error removed in v2 (served by the upstream frontend)
    expect(await dispatch(handlers, 'keys:reveal', { id: 2, confirm: true })).toMatchObject({ ok: false, error: { code: 'VALIDATION', message: 'Unknown channel' } });
  });
});
