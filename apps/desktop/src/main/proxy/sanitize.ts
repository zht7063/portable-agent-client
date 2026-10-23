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
  /\bsk-[A-Za-z0-9_-]{16,}/g,                          // sk- keys: any custom length (16-128 and beyond), may contain - and _
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, // JWT-like
  /otpauth:\/\/[^\s"']+/g,
];
/*
 * M7 (Aegis): bare (unprefixed) keys in free text. A run of 16-128 [A-Za-z0-9_-] chars counts as a key only if it
 * looks random (see looksLikeBareKey); ordinary IDs (hex digests, UUIDs, numeric/lowercase request IDs) do not.
 */
// Plain text: a run is delimited only by non-[A-Za-z0-9_-] chars, so K in `https://h/K`, `K/x`, `K+`, `K=`, `x+K` is
// masked. The + / = special case applies only inside a recognised base64 span (below).
const BARE_RUN = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{16,128}(?![A-Za-z0-9_-])/g;
/**
 * The only base64 exception (Aegis M7): a word-boundary `data:image/<subtype>;base64,` whose payload is valid base64
 * (alphabet, <= 2 trailing '=', length % 4 == 0, >= MIN_B64_PAYLOAD chars) AND decodes to a PNG/JPEG/GIF/WebP/SVG
 * header. Inside that payload, runs bounded by + / = or a line break, or by the payload's own start/end, are image
 * data (not masked). Everything else -- any other data: form, any unprefixed base64 -- is ordinary text.
 */
const BARE_RUN_B64_IMAGE = /(?<=[^A-Za-z0-9_+/=\r\n-])[A-Za-z0-9_-]{32,128}(?=[^A-Za-z0-9_+/=\r\n-])/g;
export const MIN_B64_PAYLOAD = 64;
const B64_IMAGE = /\bdata:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/]{62,}[A-Za-z0-9+/=]{2})(?![A-Za-z0-9+/=_-])/gi;
const validB64 = (p: string, min: number) => p.length >= min && p.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(p);
const IMAGE_MAGIC = [[0x89, 0x50, 0x4e, 0x47], [0xff, 0xd8, 0xff], [0x47, 0x49, 0x46, 0x38], [0x52, 0x49, 0x46, 0x46], [0x3c]];
function imageMagic(p: string): boolean {
  const b = Buffer.from(p.slice(0, 24), 'base64');
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF') return b.subarray(8, 12).toString('latin1') === 'WEBP';
  return IMAGE_MAGIC.some((m) => m.every((x, i) => b[i] === x)) || /^\s*<(?:\?xml|svg)/.test(b.toString('latin1'));
}
const ID_LIKE = [
  /^[0-9a-f]+$/i,                                                          // hex digests / hex IDs (any case)
  /^[0-9a-f]{8}(?:-?[0-9a-f]{4}){3}-?[0-9a-f]{12}(?:[-_][0-9a-z]+)*$/i,     // UUID-ish (optionally suffixed)
  /^[0-9a-z_-]+$/,                                                         // single-case: request IDs, slugs, names
  /^[0-9A-Z_-]+$/,                                                         // single-case upper: CONSTANT_NAMES, base32
];
/**
 * Heuristic for an unprefixed key: >= 32 chars (new-api keys are 48), upper + lower + digit (base62-random), not
 * ID-like, and at least 32 "key" chars once - and _ are removed (so word-ish identifiers like foo_bar_Baz1 don't match).
 */
export function looksLikeBareKey(s: string): boolean {
  if (s.length < 32 || s.length > 128) return false;
  if (!/[a-z]/.test(s) || !/[A-Z]/.test(s) || !/[0-9]/.test(s)) return false;
  if (ID_LIKE.some((re) => re.test(s))) return false;
  if (s.replace(/[-_]/g, '').length < 32) return false;
  if (/^[A-Za-z_-]+[0-9]*$/.test(s)) return false; // camelCase identifier with a trailing number
  // Random keys switch between lower/upper/digit many times; identifiers made of words do so rarely.
  const cls = (c: string) => (/[a-z]/.test(c) ? 0 : /[A-Z]/.test(c) ? 1 : /[0-9]/.test(c) ? 2 : 3);
  let switches = 0;
  for (let i = 1; i < s.length; i++) if (cls(s[i]!) !== cls(s[i - 1]!)) switches++;
  return switches >= 6;
}

/** M7: `Bearer <token>` anywhere in free text (upstream error messages echoing the request). */
const BEARER = /\b(bearer\s+)([A-Za-z0-9._~+/=-]{12,})/gi;
const isRawKey = (x: string) => /^sk-[A-Za-z0-9_-]{16,}$/.test(x) || looksLikeBareKey(x); // new-api keys: 48 alnum, stored without sk-

export function maskSecret(s: string): string {
  if (s.length <= 4) return '*'.repeat(s.length);
  if (s.length <= 8) return `${s.slice(0, 2)}****${s.slice(-2)}`;
  return `${s.slice(0, 4)}**********${s.slice(-4)}`; // same shape as upstream model.MaskTokenKey
}
const isMasked = (s: string) => s.includes('****') || s.startsWith(HANDLE_PREFIX);

/** Masks secret-shaped substrings in free text (used for JSON strings and non-JSON text bodies). */
export function maskString(s: string, bare = true): string {
  let out = '', last = 0;
  for (const m of s.matchAll(B64_IMAGE)) {
    if (!validB64(m[1]!, MIN_B64_PAYLOAD) || !imageMagic(m[1]!)) continue;
    const start = m.index + m[0].length - m[1]!.length; // only the verified payload span gets the base64 treatment
    out += maskPlain(s.slice(last, start), bare) + maskPlain(m[1]!, bare, BARE_RUN_B64_IMAGE);
    last = m.index + m[0].length;
  }
  return out + maskPlain(s.slice(last), bare);
}
function maskPlain(s: string, bare: boolean, run: RegExp = BARE_RUN): string {
  let out = s.replace(BEARER, (_m, pre: string, tok: string) => (tok.startsWith(HANDLE_PREFIX) ? pre + tok : pre + maskSecret(tok)));
  for (const re of SECRET_SHAPE) out = out.replace(re, (m) => maskSecret(m));
  if (bare) out = out.replace(run, (m) => (looksLikeBareKey(m) ? maskSecret(m) : m));
  return out;
}

/**
 * Aegis N2: text that may end up in an error (upstream `message`, etc.). Masks secret shapes, any long opaque run
 * (raw 48-char token keys, access tokens) and each value in `known` (e.g. the bearer token that was sent).
 */
export function maskErrorText(s: string, known: (string | null | undefined)[] = []): string {
  let out = String(s);
  for (const k of known) if (k && k.length >= 4) out = out.split(k).join(maskSecret(k));
  out = maskString(out);
  return out.replace(/[A-Za-z0-9_-]{24,}/g, (m) => maskSecret(m));
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
        if (!AMBIGUOUS.has(field) || isRawKey(x) || /^sk-/.test(x)) { stats.masked++; return maskSecret(x); }
      }
      const m = maskString(x); // no field-name exemption: real IDs survive via ID_LIKE
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
