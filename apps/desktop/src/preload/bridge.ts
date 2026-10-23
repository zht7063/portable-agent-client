import type { IpcEventMap, PaBridge } from '@pac/core/contract';

/** Minimal ipcRenderer surface (testable without electron). */
export interface IpcRendererLike {
  invoke(channel: string, req?: unknown): Promise<unknown>;
  on(channel: string, l: (e: unknown, payload: unknown) => void): unknown;
  removeListener(channel: string, l: (e: unknown, payload: unknown) => void): unknown;
}

/**
 * Aegis #5: narrow preload API. Every function is bound to one fixed channel; the renderer cannot name a channel.
 * Requests are passed as-is (main validates); there is no access to ipcRenderer itself.
 */
export function createBridge(ipc: IpcRendererLike): PaBridge {
  const call = (ch: string) => (req?: unknown) => ipc.invoke(ch, req ?? {}) as never;
  return {
    config: { get: call('config:get'), set: call('config:set') },
    harness: {
      detect: call('harness:detect'), plan: call('harness:plan'), apply: call('harness:apply'), rollback: call('harness:rollback'),
      history: call('harness:history'), rollbackPreview: call('harness:rollback:preview'), keyringStatus: call('harness:keyring:status'),
      listProfiles: call('harness:profile:list'), upsertProfile: call('harness:profile:upsert'), probeChannel: call('harness:channel:probe'),
    },
    onSessionChanged: (listener) => {
      const wrapped = (_e: unknown, payload: unknown) => listener(payload as IpcEventMap['session:changed']);
      ipc.on('session:changed', wrapped);
      return () => { ipc.removeListener('session:changed', wrapped); };
    },
  };
}
