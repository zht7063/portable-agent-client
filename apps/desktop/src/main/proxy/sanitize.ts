import { createPublicKey, randomBytes } from 'node:crypto';

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
  /** All real tokens currently held (known secrets for exact-value masking). */
  values(): string[] { return [...this.map.values()]; }
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
// Aegis M7: no upper bound -- a key glued with - or _ into a longer run (`uuid-K`, `K_<100 chars>`) is found by
// checking the whole run (if <= 128) and then each [-_]-separated segment (see maskRun).
/**
 * Aegis M7: provider object ids are not secrets, but their random tails look like keys. A run is exempt from the
 * heuristic only if it matches one of these per-prefix shapes EXACTLY (fixed tail length/charset taken from real
 * ids), so `<prefix><48-char key>` is never exempt. Known values are exact-replaced before this anyway.
 * Shapes (see docs/security-tests.md "ID prefix table" for sources); prefixes without a pinned shape were removed.
 */
export const ID_PREFIX_SHAPES: readonly { prefix: string; re: RegExp; example: string }[] = [
  { prefix: 'chatcmpl-', re: /^chatcmpl-[A-Za-z0-9]{29}$/, example: 'chatcmpl-B9MBs8CjcvOU2jLn4n570S5qMJKcT' },
  { prefix: 'resp_', re: /^resp_[0-9a-f]{48}$/, example: 'resp_67ccd2bed1ec8190b14f964abc0542670bb6a6b452d3795b' },
  { prefix: 'msg_', re: /^msg_(?:01[A-Za-z0-9]{22}|[A-Za-z0-9]{24})$/, example: 'msg_013Zva2CMHLNnXjNJJKqJ2EF' },
  { prefix: 'toolu_', re: /^toolu_01[A-Za-z0-9]{21,24}$/, example: 'toolu_01A09q90qw90lq917835lq9' },
  { prefix: 'call_', re: /^call_[A-Za-z0-9]{24}$/, example: 'call_FthC9qRpsL5kBpwwyw6c7j4k' },
  { prefix: 'asst_', re: /^asst_[A-Za-z0-9]{17,24}$/, example: 'asst_58fDQ7d8AJHDJy8dv' },
  { prefix: 'thread_', re: /^thread_[A-Za-z0-9]{24}$/, example: 'thread_HjA4mLzN0Gc8sYrd2kVuTq1E' },
  { prefix: 'run_', re: /^run_[A-Za-z0-9]{24}$/, example: 'run_Xp2uH3kQ7mVb9LcR1nWs5TzA' },
  { prefix: 'step_', re: /^step_[A-Za-z0-9]{24}$/, example: 'step_Q4wE8rT2yU6iO0pA3sD7fG1h' },
  { prefix: 'file-', re: /^file-[A-Za-z0-9]{22,24}$/, example: 'file-6F2ksmvXxt4VdoqmHRw6kL' },
];
const isProviderId = (m: string) => ID_PREFIX_SHAPES.some((x) => m.startsWith(x.prefix) && x.re.test(m));
/** Runs longer than this are masked entirely (no per-segment analysis of multi-MB blobs). */
export const MAX_BARE_RUN = 1 << 20;
const isRunChar = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 95;
/**
 * Plain text bare-key masking with a hand-written linear scanner (no regex backtracking / stack limits on huge
 * inputs). A run is a maximal [A-Za-z0-9_-] sequence, so K in `https://h/K`, `K/x`, `K+`, `K=`, `x+K` is masked.
 * No upper bound: a key glued with - or _ into a longer run (`uuid-K`, `K_<100 chars>`) is found per segment.
 */
function maskBareRuns(s: string): string {
  let out = '', last = 0, i = 0;
  const n = s.length;
  while (i < n) {
    if (!isRunChar(s.charCodeAt(i))) { i++; continue; }
    let j = i + 1; while (j < n && isRunChar(s.charCodeAt(j))) j++;
    if (j - i >= 16) {
      const run = s.slice(i, j); const m = j - i > MAX_BARE_RUN ? maskSecret(run) : maskRun(run);
      if (m !== run) { out += s.slice(last, i) + m; last = j; }
    }
    i = j;
  }
  return last === 0 ? s : out + s.slice(last);
}
function maskRun(m: string): string {
  if (isProviderId(m)) return m;
  if (m.length <= 128 && looksLikeBareKey(m)) return maskSecret(m);
  if (!/[-_]/.test(m)) return m;
  return m.split(/([-_])/).map((seg) => (looksLikeBareKey(seg) ? maskSecret(seg) : seg)).join('');
}
/**
 * The only base64 exception (Aegis M7): a word-boundary `data:image/<subtype>;base64,` whose payload is valid base64
 * (alphabet, <= 2 trailing '=', length % 4 == 0, >= MIN_B64_PAYLOAD chars) AND decodes to a PNG/JPEG/GIF/WebP/SVG
 * header. Inside that payload, runs bounded by + / = or a line break, or by the payload's own start/end, are image
 * data (not masked). Everything else -- any other data: form, any unprefixed base64 -- is ordinary text.
 */
const BARE_RUN_B64_IMAGE = /(?<=[^A-Za-z0-9_+/=\r\n-])[A-Za-z0-9_-]{32,128}(?=[^A-Za-z0-9_+/=\r\n-])/g;
export const MIN_B64_PAYLOAD = 64;
const B64_IMAGE_PREFIX = /\bdata:image\/[a-z0-9.+-]+;base64,/gi;
const validB64 = (p: string, min: number) => p.length >= min && p.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(p);
const IMAGE_MAGIC = [[0x89, 0x50, 0x4e, 0x47], [0xff, 0xd8, 0xff], [0x47, 0x49, 0x46, 0x38], [0x52, 0x49, 0x46, 0x46], [0x3c]];
function imageMagic(p: string, svg = true): boolean {
  const b = Buffer.from(p.slice(0, 24), 'base64');
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF') return b.subarray(8, 12).toString('latin1') === 'WEBP';
  return IMAGE_MAGIC.slice(0, 4).some((m) => m.every((x, i) => b[i] === x)) || (svg && (b[0] === 0x3c || /^\s*<(?:\?xml|svg)/.test(b.toString('latin1'))));
}
/** The data:image payload predicate (shared by maskString and the SSE promotion check). */
export const isDataImagePayload = (p: string): boolean => validB64(p, MIN_B64_PAYLOAD) && imageMagic(p);
const ID_LIKE = [
  /^[0-9a-f]+$/i,                                                          // hex digests / hex IDs (any case)
  /^[0-9a-f]{8}(?:-?[0-9a-f]{4}){3}-?[0-9a-f]{12}(?:[-_][0-9a-z]+)*$/,      // UUID-ish, lowercase only (uuid-K must not pass)
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
  for (const m of imageSpans(s)) {
    if (!isDataImagePayload(m.payload)) continue;
    // only the verified payload span gets the base64 treatment
    out += maskPlain(s.slice(last, m.start), bare) + maskPlain(m.payload, bare, BARE_RUN_B64_IMAGE);
    last = m.start + m.payload.length;
  }
  return out + maskPlain(s.slice(last), bare);
}
/**
 * Finds `data:image/<subtype>;base64,<payload>` spans. Same semantics as B64_IMAGE, but the (multi-MB) payload is
 * scanned with a loop: a backtracking regex over a 5 MB payload overflows the regex stack (SSE b64 images).
 */
function* imageSpans(s: string): Generator<{ start: number; payload: string }> {
  const B64 = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47 || c === 61;
  for (const m of s.matchAll(B64_IMAGE_PREFIX)) {
    const start = m.index + m[0].length;
    let j = start; while (j < s.length && B64(s.charCodeAt(j))) j++;
    if (j < s.length && (s[j] === '_' || s[j] === '-')) continue;
    const payload = s.slice(start, j);
    const eq = payload.indexOf('=');
    if (payload.length < 64 || (eq >= 0 && eq < payload.length - 2)) continue;
    yield { start, payload };
  }
}
function maskPlain(s: string, bare: boolean, run: RegExp | null = null): string {
  let out = s.replace(BEARER, (_m, pre: string, tok: string) => (tok.startsWith(HANDLE_PREFIX) ? pre + tok : pre + maskSecret(tok)));
  for (const re of SECRET_SHAPE) out = out.replace(re, (m) => maskSecret(m));
  if (bare) out = run ? out.replace(run, (m) => (looksLikeBareKey(m) ? maskSecret(m) : m)) : maskBareRuns(out);
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

/**
 * Aegis M7 1a: exact-value masking of KNOWN secrets (vault tokens, values under secret-named fields, the bearer
 * token that was sent). Applied before any heuristic and everywhere -- including inside header-verified data:image
 * payloads -- so a known key can never be smuggled out. Values shorter than MIN_KNOWN are ignored (trivial matches).
 */
export const MIN_KNOWN = 12;
export function knownSet(...groups: Iterable<string | null | undefined>[]): string[] {
  const out = new Set<string>();
  for (const g of groups) for (const k of g) if (typeof k === 'string' && k.length >= MIN_KNOWN && !isMasked(k)) out.add(k);
  return [...out].sort((a, b) => b.length - a.length); // longest first: a key that contains another is replaced whole
}
export function replaceKnown(s: string, known: readonly string[]): string {
  let out = s;
  for (const k of known) if (out.includes(k)) out = out.split(k).join(maskSecret(k));
  return out;
}

/**
 * Iris/Aegis M7: the ONLY other base64 exception besides data:image. A string under the exact key `b64_json` of an
 * element of the TOP-LEVEL `data` array (image-generation response `data[i].b64_json`, also inside SSE `data:` JSON
 * lines) that is valid base64 and decodes to a PNG/JPEG/GIF/WebP header is a confirmed image payload: same rules as a
 * data:image payload. Callers apply known-value replacement first; a payload containing a known value is not exempt
 * (it is masked as plain text, which breaks that image). Any other depth / field name / free text is plain text.
 */
export const isB64JsonImage = (p: unknown): p is string => typeof p === 'string' && validB64(p, MIN_B64_PAYLOAD) && imageMagic(p, false);
const maskImagePayload = (p: string) => maskPlain(p, true, BARE_RUN_B64_IMAGE);
/** Elements of the top-level `data` array (the only objects whose `b64_json` can be exempt). */
const imageItems = (root: unknown): Set<unknown> => {
  const d = root && typeof root === 'object' && !Array.isArray(root) ? (root as { data?: unknown }).data : undefined;
  return new Set(Array.isArray(d) ? d.filter((e) => e && typeof e === 'object' && !Array.isArray(e)) : []);
};

export interface SanitizeStats { masked: number; handles: number }

function isAuthBundle(o: Record<string, unknown>): boolean {
  return typeof o.access_token === 'string' && o.access_token.length > 0 && typeof o.token_type === 'string'
    && typeof o.session === 'object' && o.session !== null;
}

/** Deep-clean a parsed JSON body. Auth bundles get a handle; everything else secret is masked. */
export function sanitizeJson(v: unknown, vault: AccessTokenVault, stats: SanitizeStats = { masked: 0, handles: 0 }, extraKnown: Iterable<string | null | undefined> = [], exempt?: (o: Record<string, unknown>, k: string, v: unknown) => boolean): unknown {
  // Pass 1: collect known secrets (values under secret-named fields + vault tokens + caller-supplied).
  const found: string[] = [];
  const collect = (x: unknown, field: string | null): void => {
    if (typeof x === 'string') {
      if (field === 'setting' && x.startsWith('{')) { try { collect(JSON.parse(x), null); } catch { /* not JSON */ } }
      if (field !== null && SECRET_FIELDS.has(field) && (!AMBIGUOUS.has(field) || isRawKey(x) || /^sk-/.test(x))) found.push(x);
    } else if (Array.isArray(x)) {
      for (const e of x) collect(e, field !== null && SECRET_FIELDS.has(field) && !AMBIGUOUS.has(field) ? field : null);
    } else if (x && typeof x === 'object') {
      for (const [k, val] of Object.entries(x as Record<string, unknown>)) collect(val, k.toLowerCase());
    }
  };
  collect(v, null);
  const known = knownSet(found, vault.values(), extraKnown);
  const items = imageItems(v);
  // Pass 2: mask (exact known values first, everywhere; then field rules and heuristics).
  const walk = (x: unknown, field: string | null): unknown => {
    if (typeof x === 'string') {
      if (field !== null && SECRET_FIELDS.has(field) && x.length > 0 && !isMasked(x)) {
        if (!AMBIGUOUS.has(field) || isRawKey(x) || /^sk-/.test(x)) { stats.masked++; return maskSecret(x); }
      }
      // Aegis M7 2: user `setting` is JSON-in-a-string carrying webhook_secret -> field rules apply inside it.
      if (field === 'setting' && x.startsWith('{')) { try { return JSON.stringify(walk(JSON.parse(x), null)); } catch { /* not JSON */ } }
      const m = maskString(replaceKnown(x, known)); // no field-name exemption: real IDs survive via ID_LIKE
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
        if (k === 'b64_json' && items.has(o) && isB64JsonImage(val) && replaceKnown(val, known) === val) { out[k] = maskImagePayload(val); continue; }
        if (exempt?.(o, k, val)) { const r = replaceKnown(val as string, known); if (r !== val) stats.masked++; out[k] = r; continue; }
        out[k] = walk(val, k.toLowerCase());
      }
      return out;
    }
    return x;
  };
  return walk(v, null);
}

/** A PEM public key (`-----BEGIN PUBLIC KEY-----` + base64 lines). Public by definition; only known values are masked. */
export function isPemPublicKey(s: unknown): s is string {
  if (typeof s !== 'string' || s.length >= 8192) return false;
  // Header check first: createPublicKey() would also accept a PRIVATE key (deriving its public half).
  if (!/^-----BEGIN (?:RSA )?PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END (?:RSA )?PUBLIC KEY-----\s*$/.test(s)) return false;
  try {
    const k = createPublicKey(s);
    if (k.type !== 'public') return false;
    // Byte-exact: the re-exported key must equal the PEM body (no trailing / extra bytes smuggled after the key).
    const body = Buffer.from(s.replace(/-----(?:BEGIN|END) [A-Z ]+-----/g, '').replace(/\s+/g, ''), 'base64');
    const der = /BEGIN RSA PUBLIC KEY/.test(s) ? k.export({ type: 'pkcs1', format: 'der' }) : k.export({ type: 'spki', format: 'der' });
    return Buffer.compare(der, body) === 0;
  } catch { return false; }
}

/**
 * Aegis M7 3: line-wise sanitizer for text/event-stream. Each complete line (SSE frames are line-based) is masked
 * like any text body (known values, then heuristics) and forwarded immediately, so latency is one line. A partial
 * line is held until its newline arrives. Lines are never cut (a cut inside a data:image payload would break the
 * image-span recognition): a line may grow up to maxLine (= LIMITS.responseBody, the same cap as a buffered body);
 * beyond that the stream is terminated with an `event: error` frame (SSE_LINE_TOO_LARGE) and nothing of the line is sent.
 */
/**
 * One SSE line. For a `data: {json}` line whose top-level data[i].b64_json is a confirmed image (see isB64JsonImage),
 * that exact quoted value is kept as an image payload and the rest of the line is masked as text; the line is not
 * re-serialised, so it stays byte-identical when nothing secret is in it.
 */
function sseLine(t: string, known: readonly string[]): string {
  const plain = (x: string) => maskString(replaceKnown(x, known));
  const m = /^data:[ \t]?/.exec(t);
  if (!m || !t.includes('"b64_json"')) return plain(t);
  let parsed: unknown;
  try { parsed = JSON.parse(t.slice(m[0].length)); } catch { return plain(t); }
  const imgs = [...imageItems(parsed)].map((e) => (e as Record<string, unknown>).b64_json)
    .filter((p): p is string => isB64JsonImage(p) && replaceKnown(p, known) === p);
  let out = '', last = 0;
  for (const p of imgs) {
    const at = t.indexOf(`"b64_json":"${p}"`, last) >= 0 ? t.indexOf(`"b64_json":"${p}"`, last) : t.indexOf(`"b64_json": "${p}"`, last);
    if (at < 0) continue; // escaped (e.g. \/) or reordered: plain text
    const start = t.indexOf(`"${p}"`, at) + 1;
    out += plain(t.slice(last, start)) + maskImagePayload(p);
    last = start + p.length;
  }
  return out + plain(t.slice(last));
}

export const SSE_MAX_LINE = 32 << 20;        // a line with a structurally verified image payload
export const SSE_MAX_TEXT_LINE = 1 << 20;    // text on any line (outside verified image spans)
export const SSE_IMAGE_WINDOW = 8 << 10;     // the first image span must start within this many chars of the line
export const SSE_MAX_BUFFERED = 64 << 20;    // global: buffered (unflushed) chars across ALL live SSE streams
export const SSE_TOO_LARGE_FRAME = '\n\nevent: error\ndata: {"success":false,"code":"SSE_LINE_TOO_LARGE"}\n\n';
export const SSE_BUFFER_LIMIT_FRAME = '\n\nevent: error\ndata: {"success":false,"code":"SSE_BUFFER_LIMIT"}\n\n';
export interface SseLimits { maxLine: number; maxText: number; window: number }
/** Process-wide accounting of bytes held in SSE partial-line buffers (UTF-16 code units; 1 per byte for ASCII/base64). */
export class SseBudget {
  held = 0;
  constructor(readonly limit: number = SSE_MAX_BUFFERED) {}
  /** Reserve n; false (nothing reserved) if the global total would exceed the limit. */
  reserve(n: number): boolean { if (this.held + n > this.limit) return false; this.held += n; return true; }
  release(n: number): void { this.held -= n; if (this.held < 0) this.held = 0; }
}
export const sseBudget = new SseBudget();
const B64C = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47 || c === 61;

/**
 * Aegis M7: incremental, structural accounting for one SSE line. Only a `data: {` / `data:{` line can carry image
 * spans; a span starts right after `"b64_json":"` (or `"b64_json": "`) or `data:image/<type>;base64,`, the first one
 * within `window` chars, and counts as image only once its first 24 base64 chars decode to an image header
 * (PNG/JPEG/GIF/WebP; SVG too for data:image). Everything else is text and limited to maxText, so a fake marker
 * cannot buy the 32 MiB allowance: rejection happens as soon as ~maxText non-image chars have been seen.
 */
class SseLineMeter {
  len = 0; text = 0; private head = ''; private structured: boolean | null = null; private tail = '';
  private inSpan = false; private span = 0; private spanHead = ''; private svg = false; private verified = false;
  constructor(private readonly l: SseLimits) {}
  /** false = limit exceeded */
  feed(t: string): boolean {
    for (let i = 0; i < t.length; i++) {
      const c = t.charCodeAt(i); this.len++;
      if (this.structured === null) {
        this.head += t[i];
        if (this.head === 'data:{' || this.head === 'data: {') this.structured = true;
        else if (!'data:{'.startsWith(this.head) && !'data: {'.startsWith(this.head)) this.structured = false;
      }
      if (this.inSpan) {
        if (B64C(c)) {
          this.span++;
          if (this.span <= 24) this.spanHead += t[i];
          if (this.span === 24) {
            if (imageMagic(this.spanHead, this.svg)) this.verified = true;
            else { this.text += this.span; this.inSpan = false; }
          }
          continue;
        }
        if (this.span < 24) this.text += this.span;
        this.inSpan = false;
      }
      if (++this.text > this.l.maxText) return false;
      if (this.structured && (this.verified || this.len <= this.l.window)) {
        this.tail = (this.tail + t[i]).slice(-64);
        if (c === 34 && (this.tail.endsWith('"b64_json":"') || this.tail.endsWith('"b64_json": "'))) this.open(false);
        else if (c === 44 && /data:image\/[a-z0-9.+-]+;base64,$/i.test(this.tail)) this.open(true);
      }
    }
    return this.len <= this.l.maxLine;
  }
  private open(svg: boolean) { this.inSpan = true; this.span = 0; this.spanHead = ''; this.svg = svg; }
}

export function sseSanitizer(known: readonly string[], limits: Partial<SseLimits> = {}, budget: SseBudget = sseBudget): TransformStream<Uint8Array, Uint8Array> {
  const l: SseLimits = { maxLine: SSE_MAX_LINE, maxText: SSE_MAX_TEXT_LINE, window: SSE_IMAGE_WINDOW, ...limits };
  const dec = new TextDecoder(); const enc = new TextEncoder();
  const clean = (t: string) => sseLine(t, known);
  let parts: string[] = []; let meter = new SseLineMeter(l); let held = 0; let dead = false;
  const releaseAll = () => { budget.release(held); held = 0; parts = []; };
  const fail = (ctl: TransformStreamDefaultController<Uint8Array>, frame: string) => {
    dead = true; releaseAll(); ctl.enqueue(enc.encode(frame)); ctl.terminate();
  };
  const tooLarge = (ctl: TransformStreamDefaultController<Uint8Array>) => fail(ctl, SSE_TOO_LARGE_FRAME);
  type Ctl = TransformStreamDefaultController<Uint8Array>;
  // `cancel` (Streams spec 2023, Node >= 21) is not in this lib's Transformer type.
  const transformer = {
    transform(chunk: Uint8Array, ctl: Ctl) {
      if (dead) return;
      const t = dec.decode(chunk, { stream: true });
      let out = '', from = 0;
      for (;;) {
        const nl = t.indexOf('\n', from);
        const piece = nl < 0 ? t.slice(from) : t.slice(from, nl);
        if (!meter.feed(piece)) { if (out) ctl.enqueue(enc.encode(out)); tooLarge(ctl); return; }
        if (nl < 0) {
          if (piece) {
            if (!budget.reserve(piece.length)) { if (out) ctl.enqueue(enc.encode(out)); fail(ctl, SSE_BUFFER_LIMIT_FRAME); return; }
            held += piece.length; parts.push(piece);
          }
          break;
        }
        parts.push(piece); out += clean(parts.join('')) + '\n'; releaseAll(); meter = new SseLineMeter(l);
        from = nl + 1;
      }
      if (out) ctl.enqueue(enc.encode(out));
    },
    flush(ctl: Ctl) { if (dead) return; const r = parts.join('') + dec.decode(); releaseAll(); dead = true; if (r) ctl.enqueue(enc.encode(clean(r))); },
    // Consumer cancel / upstream abort: release this stream's share of the global budget (no leaks).
    cancel() { dead = true; releaseAll(); },
  };
  return new TransformStream<Uint8Array, Uint8Array>(transformer);
}

/** Response headers the renderer may see; everything else (Set-Cookie, auth, server internals) is dropped. */
const RESPONSE_HEADERS = new Set(['content-type', 'content-disposition', 'content-language', 'cache-control', 'last-modified', 'etag', 'retry-after']);
export function filterResponseHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => { if (RESPONSE_HEADERS.has(k.toLowerCase())) out[k.toLowerCase()] = maskString(v); }); // e.g. ETag
  return out;
}

/** Request headers forwarded from the renderer. Cookie/Authorization/Origin/Host are never taken from it. */
const REQUEST_HEADERS = new Set(['accept', 'accept-language', 'content-type', 'cache-control', 'x-auth-session', 'x-security-proof', 'if-none-match', 'if-modified-since']);
export function filterRequestHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => { if (REQUEST_HEADERS.has(k.toLowerCase())) out[k.toLowerCase()] = v; });
  return out;
}
