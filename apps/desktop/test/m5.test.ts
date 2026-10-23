/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest';
import { findCredentialLeaks, MemoryKeyVault, MemoryTokenStore, createCore } from '@pac/core';
import { createHandlers, dispatch } from '../src/main/ipc/handlers';
import { maskSecret } from '../src/main/proxy/sanitize';
import { tmpHarnessHost } from './harness-fixture';

const RAW = 'Qw' + '5'.repeat(44) + 'Er';
const FULL = `sk-${RAW}`;
const ORIGIN = 'http://127.0.0.1:3999';

function deps(extra: Record<string, unknown> = {}) {
  const cfg = { serverUrl: ORIGIN, insecureTransport: true, clipboardClearSeconds: 30 };
  const core = createCore({ serverUrl: ORIGIN, store: new MemoryTokenStore(), vault: new MemoryKeyVault(), fetch: async () => { throw new Error('no network'); } });
  const keys = { fetchKey: vi.fn(async () => FULL), store: vi.fn(), list: vi.fn(), copy: vi.fn(), remove: vi.fn() } as any;
  return { keys, h: createHandlers({ getCore: () => core, getConfig: () => cfg, setConfig: async () => cfg, harness: tmpHarnessHost().host.harness, keys, ...extra }) };
}

describe('M5 keys:show (native confirm + native box in main)', () => {
  it('confirmed: key goes to the native box only; response has the masked key', async () => {
    const shown: string[] = [];
    const { h, keys } = deps({ confirmRevealKey: async () => true, showKey: async (k: string) => { shown.push(k); } });
    const r = await dispatch(h, 'keys:show', { tokenId: 7 });
    expect(r).toEqual({ ok: true, data: { shown: true, tokenId: 7, maskedKey: maskSecret(FULL) } });
    expect(shown).toEqual([FULL]);
    expect(JSON.stringify(r)).not.toContain(RAW);
    expect(findCredentialLeaks(r)).toEqual([]);
    expect(keys.fetchKey).toHaveBeenCalledWith(7);
  });
  it('cancelled: the key is not even fetched', async () => {
    const showKey = vi.fn();
    const { h, keys } = deps({ confirmRevealKey: async () => false, showKey });
    expect(await dispatch(h, 'keys:show', { tokenId: 7 })).toEqual({ ok: true, data: { shown: false, tokenId: 7 } });
    expect(keys.fetchKey).not.toHaveBeenCalled(); expect(showKey).not.toHaveBeenCalled();
  });
  it('no dialog wired or bad id: refused', async () => {
    expect(await dispatch(deps().h, 'keys:show', { tokenId: 7 })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    const { h } = deps({ confirmRevealKey: async () => true, showKey: async () => {} });
    for (const tokenId of [0, -1, 1.5, '7' as any]) expect(await dispatch(h, 'keys:show', { tokenId })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
  });
});

describe('M5 server:status', () => {
  it('returns url/compat/check; recheck flag passed through', async () => {
    const serverStatus = vi.fn(async (recheck: boolean) => ({
      serverUrl: ORIGIN, insecureTransport: true, clientVersion: '0.0.0',
      compat: { tag: 'v1.0.0-rc.46', minServer: 'v1.0.0-rc.46', maxServerTested: 'v1.0.0-rc.46', policy: 'same-minor-line' },
      check: { verdict: 'ok' as const, allowLogin: true, serverVersion: 'v1.0.0-rc.46', systemName: 'New API', insecureTransport: true, unsupported: [], turnstile: false, messages: [], checkedAt: recheck ? 2 : 1 },
    }));
    const { h } = deps({ serverStatus });
    expect(await dispatch(h, 'server:status', { recheck: true })).toMatchObject({ ok: true, data: { check: { verdict: 'ok', checkedAt: 2 } } });
    expect(serverStatus).toHaveBeenLastCalledWith(true);
    await dispatch(h, 'server:status', {});
    expect(serverStatus).toHaveBeenLastCalledWith(false);
    expect(await dispatch(deps().h, 'server:status', {})).toMatchObject({ ok: false });
  });
});
