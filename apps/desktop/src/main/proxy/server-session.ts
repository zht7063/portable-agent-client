import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CookieJar, type StoredCookie } from './cookie-jar';
import { AccessTokenVault } from './sanitize';
import { ServerProxy, type ProxyRequest } from './api-proxy';
import { checkServer, type CompatRange, type FetchLike, type ServerCheck } from './server-status';

/*
 * M3: owns the main-only server session (cookie jar + access-token vault), the /api/status check and the proxy.
 * Electron-free; index.ts injects safeStorage-based encryption. Cookies persist encrypted (refresh cookie, so a
 * restart can resume); the access token is memory-only. Without encryption the jar is memory-only.
 */
export interface Cipher { encrypt(s: string): Buffer; decrypt(b: Buffer): string }
export interface ServerSessionOptions {
  compat: CompatRange;
  fetch: FetchLike;
  /** Encrypted persistence file; null = memory only. */
  file: string | null;
  cipher: Cipher | null;
}

export class ServerSession {
  readonly vault = new AccessTokenVault();
  jar = new CookieJar();
  private origin: string | null = null;
  private check: ServerCheck | null = null;
  readonly proxy: ServerProxy;

  constructor(private readonly o: ServerSessionOptions) {
    this.proxy = new ServerProxy({
      getOrigin: () => this.origin, getCheck: () => this.check, getJar: () => this.jar, vault: this.vault, fetch: o.fetch,
    });
  }

  get serverCheck(): ServerCheck | null { return this.check; }
  get serverOrigin(): string | null { return this.origin; }

  /** Switch to a server (or none). Session data from another origin is discarded. */
  async setServer(serverUrl: string | null): Promise<void> {
    const origin = serverUrl ? new URL(serverUrl).origin : null;
    if (origin === this.origin) return;
    this.origin = origin;
    this.check = null;
    this.vault.clear();
    const saved = origin ? await this.load(origin) : [];
    this.jar = new CookieJar((all) => void this.persist(all), saved);
    if (!origin) await this.wipe();
  }

  /** Public /api/status check (no credentials). Cached until the next call / server change. */
  async runCheck(): Promise<ServerCheck | null> {
    if (!this.origin) return null;
    const origin = this.origin;
    const c = await checkServer(this.o.compat, origin, this.o.fetch);
    if (this.origin === origin) this.check = c;
    return c;
  }

  handle(req: ProxyRequest): Promise<Response> { return this.proxy.handle(req); }

  private async load(origin: string): Promise<StoredCookie[]> {
    if (!this.o.file || !this.o.cipher) return [];
    try {
      const v = JSON.parse(this.o.cipher.decrypt(await readFile(this.o.file))) as { origin?: string; cookies?: StoredCookie[] };
      return v.origin === origin && Array.isArray(v.cookies) ? v.cookies : [];
    } catch { return []; }
  }
  private async persist(cookies: StoredCookie[]): Promise<void> {
    if (!this.o.file || !this.o.cipher || !this.origin) return;
    if (!cookies.length) return this.wipe();
    await mkdir(dirname(this.o.file), { recursive: true });
    await writeFile(this.o.file, this.o.cipher.encrypt(JSON.stringify({ origin: this.origin, cookies })), { mode: 0o600 });
  }
  private async wipe(): Promise<void> { if (this.o.file) await rm(this.o.file, { force: true }); }
}
