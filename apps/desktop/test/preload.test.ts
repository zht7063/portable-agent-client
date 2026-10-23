import { describe, expect, it, vi } from 'vitest';
import { BRIDGE_CHANNELS, INVOKE_CHANNELS } from '@pac/core/contract';
import { createBridge } from '../src/preload/bridge';

describe('Aegis #5: narrow preload bridge', () => {
  it('exposes only named functions, each bound to its fixed channel; no generic invoke/on', async () => {
    const ipc = { invoke: vi.fn(async () => ({ ok: true })), on: vi.fn(), removeListener: vi.fn() };
    const b = createBridge(ipc) as unknown as Record<string, unknown>;
    expect(Object.keys(b).sort()).toEqual(['config', 'harness', 'onSessionChanged']);
    expect('invoke' in b || 'on' in b || 'send' in b).toBe(false);
    for (const [path, ch] of Object.entries(BRIDGE_CHANNELS)) {
      const [ns, fn] = path.split('.') as [string, string];
      const f = (b[ns] as Record<string, (r?: unknown) => Promise<unknown>>)[fn];
      expect(typeof f).toBe('function');
      ipc.invoke.mockClear();
      await f!({ channel: 'config:set', x: 1 });
      expect(ipc.invoke).toHaveBeenCalledWith(ch, { channel: 'config:set', x: 1 }); // a "channel" field cannot redirect
    }
    const fns = Object.values(b).flatMap((v) => (typeof v === 'function' ? [v] : Object.values(v as object)));
    expect(fns.length).toBe(Object.keys(BRIDGE_CHANNELS).length + 1);
    expect(new Set(Object.values(BRIDGE_CHANNELS))).toEqual(new Set(INVOKE_CHANNELS));
  });
  it('session listener is fixed to session:changed and removable', () => {
    const ipc = { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() };
    const off = createBridge(ipc).onSessionChanged(() => {});
    expect(ipc.on).toHaveBeenCalledWith('session:changed', expect.any(Function));
    off();
    expect(ipc.removeListener).toHaveBeenCalledWith('session:changed', ipc.on.mock.calls[0]![1]);
  });
});
