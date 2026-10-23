import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isInsecureServerUrl, normalizeServerUrl, type ClientConfig, type ConfigSetReq } from '@pac/core';

/** Persisted (non-secret) desktop config: userData/config.json. No built-in server: null until configured. */
export interface PersistedConfig { version: 2; serverUrl: string | null }

export const toClientConfig = (p: PersistedConfig): ClientConfig => ({
  serverUrl: p.serverUrl,
  insecureTransport: p.serverUrl !== null && isInsecureServerUrl(p.serverUrl),
});

export class ConfigStore {
  /** @param seedServerUrl optional seed (PAC_SERVER_URL, dev only); a saved config.json wins. Invalid seeds are ignored. */
  constructor(private readonly path: string, private readonly seedServerUrl?: string) {}

  defaults(): PersistedConfig {
    let serverUrl: string | null = null;
    try { if (this.seedServerUrl) serverUrl = normalizeServerUrl(this.seedServerUrl); } catch { /* ignore bad seed */ }
    return { version: 2, serverUrl };
  }

  /** Loads config; missing or invalid fields fall back to defaults (file is never trusted blindly). */
  async load(): Promise<PersistedConfig> {
    const d = this.defaults();
    let raw: { serverUrl?: unknown };
    try { raw = JSON.parse(await readFile(this.path, 'utf8')) as { serverUrl?: unknown }; } catch { return d; }
    let serverUrl = d.serverUrl;
    try { if (typeof raw?.serverUrl === 'string') serverUrl = normalizeServerUrl(raw.serverUrl); } catch { /* keep default */ }
    return { version: 2, serverUrl };
  }

  /** Validates a patch against the current config (throws PaException VALIDATION). */
  apply(cur: PersistedConfig, patch: ConfigSetReq): PersistedConfig {
    return { version: 2, serverUrl: patch?.serverUrl !== undefined ? normalizeServerUrl(patch.serverUrl) : cur.serverUrl };
  }

  /** Atomic write (tmp + rename). */
  async save(c: PersistedConfig): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(c, null, 2), { mode: 0o600 });
    await rename(tmp, this.path);
  }
}
