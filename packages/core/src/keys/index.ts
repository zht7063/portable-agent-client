import { PaException } from '../contract/errors.js';
import type { HttpClient } from '../http/client.js';

/**
 * token -> keychain orchestration only (main process). Token list/create/edit is the upstream frontend's job.
 * Full keys stay in main; they go vault/keychain, never to the renderer.
 */
export interface KeyVault {
  get(id: number): Promise<string | null>;
  set(id: number, secret: string): Promise<void>;
  delete(id: number): Promise<void>;
  has(id: number): Promise<boolean>;
}
export class MemoryKeyVault implements KeyVault {
  private m = new Map<number, string>();
  async get(id: number) { return this.m.get(id) ?? null; }
  async set(id: number, s: string) { this.m.set(id, s); }
  async delete(id: number) { this.m.delete(id); }
  async has(id: number) { return this.m.has(id); }
}

/** Adds the sk- prefix used by the relay. */
export const toSk = (raw: string): string => (raw.startsWith('sk-') ? raw : `sk-${raw}`);

export interface KeysModule {
  /** Main-process only: full sk (cached; POST /api/token/:id/key is rate-limited). */
  secret(id: number): Promise<string>;
  /** Drops a cached key (e.g. after the token was deleted upstream). */
  forget(id: number): Promise<void>;
}

export function createKeys(http: HttpClient, vault: KeyVault = new MemoryKeyVault()): KeysModule {
  return {
    async secret(id) {
      if (!Number.isSafeInteger(id) || id <= 0) throw new PaException({ code: 'VALIDATION', message: 'Invalid key id' });
      const cached = await vault.get(id);
      if (cached) return cached;
      const d = await http.api<{ key: string }>('POST', `/api/token/${id}/key`);
      if (!d?.key) throw new PaException({ code: 'SERVER', message: 'Server returned no key' });
      const sk = toSk(d.key);
      await vault.set(id, sk);
      return sk;
    },
    forget: (id) => vault.delete(id),
  };
}
