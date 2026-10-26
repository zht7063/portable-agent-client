import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { HarnessProfile } from '@pac/core';
import type { ControlledFs, StateStore } from '@pac/core/fs';
import { PROVIDER_ID } from './keyfile.js';
/** Main-generated identifiers; display labels never form paths or shell arguments. */
export const newProviderId = () => `swift-${randomUUID().slice(0, 8)}`;
export class Providers {
  constructor(private fs: ControlledFs, private state: StateStore) {}
  async activate(id: string): Promise<HarnessProfile> {
    if (!PROVIDER_ID.test(id)) throw new Error('Invalid provider id');
    const p = (await this.state.load()).profiles[id];
    if (!p) throw new Error('Unknown provider');
    await this.state.update((s) => { s.activeProvider = id; });
    await this.sync();
    return p;
  }
  async sync(): Promise<void> {
    const s = await this.state.load();
    const providers = Object.values(s.profiles).map((p) => ({ id: p.id, label: p.label ?? p.id, keyRef: { tokenId: p.keyId }, models: p.models }));
    await this.fs.atomicWrite(join(this.fs.dataDir, 'harness/providers.json'), JSON.stringify({ providers, activeProvider: s.activeProvider ?? null }));
  }
}
