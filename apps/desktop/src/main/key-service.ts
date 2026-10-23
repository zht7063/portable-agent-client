import { createHash } from 'node:crypto';
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
  clipboard: { writeText(text: string): void; readText(): string; clear(): void };
  /** Aegis N1: seconds until the copied key is cleared from the clipboard (0 = off). Read at copy time. */
  clipboardClearSeconds?: () => number;
  /** Non-secret metadata file (token id / name / masked key per keychain entry). */
  metaFile: string;
  now?: () => Date;
}

type Meta = Record<string, Omit<StoredKeyInfo, 'present'>>; // account -> info

const toSk = (raw: string) => (raw.startsWith('sk-') ? raw : `sk-${raw}`);
const validId = (id: unknown): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0;

/**
 * Builds the dashboard's "Copy curl" text (same shape as upstream's buildCurlCommand) in main. Inputs come from the
 * renderer and end up in a shell, so they are validated strictly: endpoint must be a plain http(s) URL without
 * credentials or shell-significant characters; model a conservative charset.
 */
export function buildCurl(endpoint: unknown, model: unknown, key: string): string {
  const bad = () => new PaException({ code: 'VALIDATION', message: 'Invalid curl endpoint/model' });
  if (typeof endpoint !== 'string' || typeof model !== 'string' || endpoint.length > 2048) throw bad();
  let u: URL;
  try { u = new URL(endpoint); } catch { throw bad(); }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) throw bad();
  const href = u.href;
  // Single-quoted in the output, so only a quote could break out; allow RFC 3986 characters minus ' (and no $ or `).
  if (!/^[A-Za-z0-9\-._~:/?#[\]@!&()*+,;=%]+$/.test(href)) throw bad();
  if (!/^[A-Za-z0-9._:/@+-]{1,128}$/.test(model)) throw bad();
  return [
    `curl '${href}' \\`,
    '  -H "Content-Type: application/json" \\',
    `  -H "Authorization: Bearer ${key}" \\`,
    `  -d '{"model":"${model}","messages":[{"role":"user","content":"Say hello in one sentence."}]}'`,
  ].join('\n');
}

const digest = (s: string) => createHash('sha256').update(s).digest('hex');

export class KeyService {
  /** Hash of the key last written to the clipboard (the key itself is not retained). */
  private clipHash: string | null = null;
  private clipTimer: ReturnType<typeof setTimeout> | null = null;
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

  /**
   * Full key goes main -> clipboard only. Aegis N1 (plan §2): auto-clear after `clipboardClearSeconds` (default 30)
   * and on quit, but only if the clipboard still holds that key (compared by hash in main; never logged).
   */
  async copy(tokenId: number, curl?: { endpoint: string; model: string }): Promise<KeysCopyRes> {
    if (curl !== undefined && (curl === null || typeof curl !== 'object')) throw new PaException({ code: 'VALIDATION', message: 'Invalid curl endpoint/model' });
    if (curl) buildCurl(curl.endpoint, curl.model, 'sk-x'); // validate before fetching the key
    const key = await this.fetchKey(tokenId);
    const text = curl ? buildCurl(curl.endpoint, curl.model, key) : key;
    this.o.clipboard.writeText(text);
    this.clipHash = digest(text);
    if (this.clipTimer) clearTimeout(this.clipTimer);
    this.clipTimer = null;
    const secs = this.o.clipboardClearSeconds?.() ?? 30;
    if (secs > 0) {
      this.clipTimer = setTimeout(() => { this.clipTimer = null; this.clearClipboardIfOurs(); }, secs * 1000);
      (this.clipTimer as { unref?: () => void }).unref?.();
    }
    return { copied: true, tokenId, maskedKey: maskSecret(key) };
  }

  /** Clears the clipboard iff it still contains the key we copied. Returns true if cleared. Also used on quit. */
  clearClipboardIfOurs(): boolean {
    const h = this.clipHash;
    if (this.clipTimer) { clearTimeout(this.clipTimer); this.clipTimer = null; }
    if (!h) return false;
    this.clipHash = null;
    let cur = '';
    try { cur = this.o.clipboard.readText(); } catch { return false; }
    if (digest(cur) !== h) return false;
    this.o.clipboard.clear();
    return true;
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
