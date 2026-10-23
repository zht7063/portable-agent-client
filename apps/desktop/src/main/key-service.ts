import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { HARNESS_IDS, PaException, isHarnessId, type HarnessId, type KeysCopyRes, type KeysListRes, type StoredKeyInfo } from '@pac/core';
import { accountFor, type Keyring } from '@pac/keychain';
import { maskSecret } from './proxy/sanitize';

/*
 * M4 (plan v2 §2 "Key"): token -> keychain. The renderer only ever sends a token id; main fetches the full key
 * through the main-only server session (POST /api/token/:id/key), writes it straight into the OS keychain
 * (service = product keychainService, account `<profile>/<harness>`) or the clipboard, and returns masked metadata.
 * Electron-free: the API caller and the clipboard are injected.
 */

/** Single profile in M4 (no multi-profile). */
export const DEFAULT_PROFILE = 'default';

export interface KeyServiceOptions {
  keyring: Keyring;
  /** Main-only authenticated standard-API call (ServerSession.mainApi). */
  api<T>(method: 'GET' | 'POST', path: string): Promise<T>;
  clipboard: { writeText(text: string): void };
  /** Non-secret metadata file (token id / name / masked key per keychain entry). */
  metaFile: string;
  now?: () => Date;
}

type Meta = Record<string, Omit<StoredKeyInfo, 'present'>>; // account -> info

const toSk = (raw: string) => (raw.startsWith('sk-') ? raw : `sk-${raw}`);
const validId = (id: unknown): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0;

export class KeyService {
  constructor(private readonly o: KeyServiceOptions) {}

  /** Main-only. Never return this value over IPC. */
  async fetchKey(tokenId: number): Promise<string> {
    if (!validId(tokenId)) throw new PaException({ code: 'VALIDATION', message: 'Invalid token id' });
    const d = await this.o.api<{ key?: unknown }>('POST', `/api/token/${tokenId}/key`);
    if (!d || typeof d.key !== 'string' || !d.key) throw new PaException({ code: 'SERVER', message: 'Server returned no key' });
    return toSk(d.key);
  }

  private async tokenName(tokenId: number): Promise<string> {
    try { const d = await this.o.api<{ name?: unknown }>('GET', `/api/token/${tokenId}`); return typeof d?.name === 'string' ? d.name.slice(0, 100) : ''; }
    catch { return ''; }
  }

  private async requireKeyring(): Promise<void> {
    if (!(await this.o.keyring.available().catch(() => ({ ok: false }))).ok) {
      throw new PaException({ code: 'VALIDATION', message: 'System keychain unavailable; use env key mode (export the key in your shell). Nothing was stored. 系统钥匙串不可用，请改用环境变量模式。' });
    }
  }

  /** keys:store (renderer-initiated): default profile only. */
  async store(tokenId: number, harness: HarnessId, profileId = DEFAULT_PROFILE): Promise<StoredKeyInfo> {
    if (profileId !== DEFAULT_PROFILE) throw new PaException({ code: 'VALIDATION', message: 'Only the default profile is supported' });
    return this.write(profileId, harness, tokenId);
  }

  /** Harness apply (command key mode): (re)store only if the entry is missing or bound to another token. */
  async ensure(profileId: string, harness: HarnessId, tokenId: number): Promise<void> {
    const account = accountFor(profileId, harness);
    await this.requireKeyring();
    if ((await this.load())[account]?.tokenId === tokenId && (await this.o.keyring.get(account)) !== null) return;
    await this.write(profileId, harness, tokenId);
  }

  private async write(profileId: string, harness: HarnessId, tokenId: number): Promise<StoredKeyInfo> {
    if (!validId(tokenId)) throw new PaException({ code: 'VALIDATION', message: 'Invalid token id' });
    if (!isHarnessId(harness)) throw new PaException({ code: 'VALIDATION', message: 'Invalid harness' });
    const account = accountFor(profileId, harness);
    await this.requireKeyring();
    const key = await this.fetchKey(tokenId);
    await this.o.keyring.set(account, key);
    const info = { profileId, harness, tokenId, tokenName: await this.tokenName(tokenId), maskedKey: maskSecret(key), storedAt: (this.o.now?.() ?? new Date()).toISOString() };
    const meta = await this.load(); meta[account] = info; await this.save(meta);
    return { ...info, present: true };
  }

  async list(): Promise<KeysListRes> {
    const a = await this.o.keyring.available().catch(() => ({ ok: false, reason: 'keychain check failed' }));
    const meta = await this.load();
    const entries: StoredKeyInfo[] = [];
    for (const h of HARNESS_IDS) {
      const account = accountFor(DEFAULT_PROFILE, h);
      const m = meta[account];
      if (!m) continue;
      let present = false;
      if (a.ok) { try { present = (await this.o.keyring.get(account)) !== null; } catch { present = false; } }
      entries.push({ ...m, present });
    }
    if (!a.ok) return { available: false, backend: this.o.keyring.backend, fallback: 'env', ...('reason' in a && a.reason ? { reason: a.reason } : {}), entries };
    return { available: true, backend: this.o.keyring.backend, entries };
  }

  /** Full key goes main -> clipboard only. (Auto-clear is deferred, plan open decision.) */
  async copy(tokenId: number): Promise<KeysCopyRes> {
    const key = await this.fetchKey(tokenId);
    this.o.clipboard.writeText(key);
    return { copied: true, tokenId, maskedKey: maskSecret(key) };
  }

  async remove(harness: HarnessId, profileId = DEFAULT_PROFILE): Promise<{ removed: boolean }> {
    if (!isHarnessId(harness)) throw new PaException({ code: 'VALIDATION', message: 'Invalid harness' });
    const account = accountFor(profileId, harness);
    let removed = false;
    if ((await this.o.keyring.available().catch(() => ({ ok: false }))).ok) removed = await this.o.keyring.delete(account);
    const meta = await this.load();
    if (meta[account]) { delete meta[account]; await this.save(meta); removed = true; }
    return { removed };
  }

  private async load(): Promise<Meta> {
    try { const v = JSON.parse(await readFile(this.o.metaFile, 'utf8')) as unknown; return v && typeof v === 'object' ? (v as Meta) : {}; }
    catch { return {}; }
  }
  private async save(m: Meta): Promise<void> {
    await mkdir(dirname(this.o.metaFile), { recursive: true });
    const tmp = `${this.o.metaFile}.tmp`;
    await writeFile(tmp, JSON.stringify(m, null, 2), { mode: 0o600 });
    await rename(tmp, this.o.metaFile);
  }
}
