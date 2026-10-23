import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CLIPBOARD_CLEAR_DEFAULT, CLIPBOARD_CLEAR_MAX, PaException, isInsecureServerUrl, normalizeServerUrl, type ClientConfig, type ConfigSetReq } from '@pac/core';

/** Persisted (non-secret) desktop config: userData/config.json. No built-in server: null until configured. */
export interface PersistedConfig { version: 2; serverUrl: string | null; clipboardClearSeconds?: number }

const validClear = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= CLIPBOARD_CLEAR_MAX;
export function normalizeClipboardClear(v: unknown): number {
  if (!validClear(v)) throw new PaException({ code: 'VALIDATION', message: `clipboardClearSeconds must be an integer 0..${CLIPBOARD_CLEAR_MAX} (0 = off)` });
  return v;
}

export const toClientConfig = (p: PersistedConfig): ClientConfig => ({
  serverUrl: p.serverUrl,
  insecureTransport: p.serverUrl !== null && isInsecureServerUrl(p.serverUrl),
  clipboardClearSeconds: validClear(p.clipboardClearSeconds) ? p.clipboardClearSeconds : CLIPBOARD_CLEAR_DEFAULT,
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
    let raw: { serverUrl?: unknown; clipboardClearSeconds?: unknown };
    try { raw = JSON.parse(await readFile(this.path, 'utf8')) as typeof raw; } catch { return d; }
    let serverUrl = d.serverUrl;
    try { if (typeof raw?.serverUrl === 'string') serverUrl = normalizeServerUrl(raw.serverUrl); } catch { /* keep default */ }
    return { version: 2, serverUrl, ...(validClear(raw?.clipboardClearSeconds) ? { clipboardClearSeconds: raw.clipboardClearSeconds } : {}) };
  }

  /** Validates a patch against the current config (throws PaException VALIDATION). */
  apply(cur: PersistedConfig, patch: ConfigSetReq): PersistedConfig {
    const clear = patch?.clipboardClearSeconds !== undefined ? normalizeClipboardClear(patch.clipboardClearSeconds) : cur.clipboardClearSeconds;
    return {
      version: 2, serverUrl: patch?.serverUrl !== undefined ? normalizeServerUrl(patch.serverUrl) : cur.serverUrl,
      ...(clear !== undefined ? { clipboardClearSeconds: clear } : {}),
    };
  }

  /** Atomic write (tmp + rename). */
  async save(c: PersistedConfig): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(c, null, 2), { mode: 0o600 });
    await rename(tmp, this.path);
  }
}
