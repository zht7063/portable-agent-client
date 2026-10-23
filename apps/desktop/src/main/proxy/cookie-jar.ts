/*
 * M3: main-only cookie jar for the configured server (plan v2 §2). The renderer partition never receives
 * these cookies: the proxy strips Set-Cookie and attaches Cookie itself. Single origin by construction.
 */
export interface StoredCookie { name: string; value: string; path: string; expires: number | null; secure: boolean }

export class CookieJar {
  private cookies = new Map<string, StoredCookie>(); // key = name + '\0' + path
  constructor(private readonly onChange?: (all: StoredCookie[]) => void, initial: StoredCookie[] = []) {
    for (const c of initial) this.cookies.set(`${c.name}\0${c.path}`, c);
  }

  /** Apply Set-Cookie header values received from the pinned origin. */
  store(setCookies: string[], requestPath: string, now = Date.now()): void {
    let changed = false;
    for (const raw of setCookies) {
      const c = parseSetCookie(raw, requestPath, now);
      if (!c) continue;
      const k = `${c.name}\0${c.path}`;
      if (c.expires !== null && c.expires <= now) changed = this.cookies.delete(k) || changed;
      else { this.cookies.set(k, c); changed = true; }
    }
    if (changed) this.onChange?.(this.all());
  }

  /** Cookie header for a request path (RFC 6265 path-match), or null. */
  header(path: string, secureTransport: boolean, now = Date.now()): string | null {
    const out: string[] = [];
    for (const c of this.cookies.values()) {
      if (c.expires !== null && c.expires <= now) continue;
      if (c.secure && !secureTransport) continue;
      if (!pathMatch(path, c.path)) continue;
      out.push(`${c.name}=${c.value}`);
    }
    return out.length ? out.join('; ') : null;
  }

  all(): StoredCookie[] { return [...this.cookies.values()]; }
  get size(): number { return this.cookies.size; }
  clear(): void { if (this.cookies.size) { this.cookies.clear(); this.onChange?.([]); } }
}

export function pathMatch(reqPath: string, cookiePath: string): boolean {
  if (reqPath === cookiePath) return true;
  if (!reqPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || reqPath[cookiePath.length] === '/';
}

function defaultPath(p: string): string {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

export function parseSetCookie(raw: string, requestPath: string, now: number): StoredCookie | null {
  const [pair = '', ...attrs] = raw.split(';');
  const eq = pair.indexOf('=');
  if (eq <= 0) return null;
  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  if (!name) return null;
  let path = defaultPath(requestPath), expires: number | null = null, secure = false, maxAgeSeen = false;
  for (const a of attrs) {
    const i = a.indexOf('=');
    const k = (i < 0 ? a : a.slice(0, i)).trim().toLowerCase();
    const v = i < 0 ? '' : a.slice(i + 1).trim();
    if (k === 'path' && v.startsWith('/')) path = v;
    else if (k === 'max-age' && /^-?\d+$/.test(v)) { maxAgeSeen = true; expires = Number(v) <= 0 ? 0 : now + Number(v) * 1000; }
    else if (k === 'expires' && !maxAgeSeen) { const t = Date.parse(v); if (!Number.isNaN(t)) expires = t; }
    else if (k === 'secure') secure = true;
    // Domain is ignored on purpose: the jar is pinned to one origin.
  }
  return { name, value, path, expires, secure };
}
