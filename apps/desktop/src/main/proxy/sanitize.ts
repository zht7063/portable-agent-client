import { randomBytes } from 'node:crypto';

/*
 * M3: response cleaning before anything reaches the renderer (plan v2 §2, §8 "遗漏清洗即泄露").
 *  1. Auth bundles (login / refresh / 2FA / passkey responses: data.access_token + token_type + session) — the real
 *     access token is kept in main; the renderer gets an opaque handle `pac-h.<random>` that only this proxy honours.
 *  2. Secret-named fields are masked wherever they appear (any depth).
 *  3. Secret-shaped strings are masked anywhere (sk- keys, 48-char token keys in `key`, JWT-like, otpauth URIs).
 */

export const HANDLE_PREFIX = 'pac-h.';

/** Holds the real access token(s); hands out opaque per-issue handles. Memory only. */
export class AccessTokenVault {
  private map = new Map<string, string>(); // handle -> real token (latest two, for in-flight requests)
  issue(real: string): string {
    const h = HANDLE_PREFIX + randomBytes(24).toString('base64url');
    this.map.set(h, real);
    while (this.map.size > 2) this.map.delete(this.map.keys().next().value as string);
    return h;
  }
  resolve(handle: string): string | null { return this.map.get(handle) ?? null; }
  /** Most recently issued real token (main-only API calls, M4). */
  latest(): string | null { let v: string | null = null; for (const t of this.map.values()) v = t; return v; }
  clear(): void { this.map.clear(); }
  get size(): number { return this.map.size; }
}

/** Field names whose string values are always masked. */
const SECRET_FIELDS = new Set([
  'key', 'api_key', 'apikey', 'access_token', 'refresh_token', 'id_token', 'token', 'secret', 'client_secret',
  'password', 'original_password', 'totp_secret', 'backup_codes', 'qr_code_data', 'session_secret', 'webhook_secret',
  'private_key', 'secret_key', 'sk', 'credential', 'credentials', 'authorization', 'cookie',
]);
/** `key` is also an ordinary field (e.g. /api/option returns {key: "SMTPServer", value}). Mask only secret-shaped. */
const AMBIGUOUS = new Set(['key', 'token', 'sk']);
const SECRET_SHAPE = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,                          // OpenAI-style / new-api display keys
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, // JWT-like
  /otpauth:\/\/[^\s"']+/g,
];
const RAW_KEY = /^(sk-)?[A-Za-z0-9_-]{32,}$/;           // new-api token keys are 48 alnum chars (stored without sk-)

export function maskSecret(s: string): string {
  if (s.length <= 4) return '*'.repeat(s.length);
  if (s.length <= 8) return `${s.slice(0, 2)}****${s.slice(-2)}`;
  return `${s.slice(0, 4)}**********${s.slice(-4)}`; // same shape as upstream model.MaskTokenKey
}
const isMasked = (s: string) => s.includes('****') || s.startsWith(HANDLE_PREFIX);

function maskString(s: string): string {
  let out = s;
  for (const re of SECRET_SHAPE) out = out.replace(re, (m) => maskSecret(m));
  return out;
}

export interface SanitizeStats { masked: number; handles: number }

function isAuthBundle(o: Record<string, unknown>): boolean {
  return typeof o.access_token === 'string' && o.access_token.length > 0 && typeof o.token_type === 'string'
    && typeof o.session === 'object' && o.session !== null;
}

/** Deep-clean a parsed JSON body. Auth bundles get a handle; everything else secret is masked. */
export function sanitizeJson(v: unknown, vault: AccessTokenVault, stats: SanitizeStats = { masked: 0, handles: 0 }): unknown {
  const walk = (x: unknown, field: string | null): unknown => {
    if (typeof x === 'string') {
      if (field !== null && SECRET_FIELDS.has(field) && x.length > 0 && !isMasked(x)) {
        if (!AMBIGUOUS.has(field) || RAW_KEY.test(x) || /^sk-/.test(x)) { stats.masked++; return maskSecret(x); }
      }
      const m = maskString(x);
      if (m !== x) stats.masked++;
      return m;
    }
    if (Array.isArray(x)) {
      // backup_codes etc: arrays under a secret field are masked element-wise.
      return x.map((e) => (field !== null && SECRET_FIELDS.has(field) && !AMBIGUOUS.has(field) && typeof e === 'string' ? (stats.masked++, maskSecret(e)) : walk(e, null)));
    }
    if (x && typeof x === 'object') {
      const o = x as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      const bundle = isAuthBundle(o);
      for (const [k, val] of Object.entries(o)) {
        if (bundle && k === 'access_token') { out[k] = vault.issue(val as string); stats.handles++; continue; }
        out[k] = walk(val, k.toLowerCase());
      }
      return out;
    }
    return x;
  };
  return walk(v, null);
}

/** Response headers the renderer may see; everything else (Set-Cookie, auth, server internals) is dropped. */
const RESPONSE_HEADERS = new Set(['content-type', 'content-disposition', 'content-language', 'cache-control', 'last-modified', 'etag', 'retry-after']);
export function filterResponseHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => { if (RESPONSE_HEADERS.has(k.toLowerCase())) out[k.toLowerCase()] = v; });
  return out;
}

/** Request headers forwarded from the renderer. Cookie/Authorization/Origin/Host are never taken from it. */
const REQUEST_HEADERS = new Set(['accept', 'accept-language', 'content-type', 'cache-control', 'x-auth-session', 'x-security-proof', 'if-none-match', 'if-modified-since']);
export function filterRequestHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => { if (REQUEST_HEADERS.has(k.toLowerCase())) out[k.toLowerCase()] = v; });
  return out;
}
