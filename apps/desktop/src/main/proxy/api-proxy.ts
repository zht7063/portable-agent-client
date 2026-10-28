import { canonicalisePath, decide } from './allowlist';
import type { CookieJar } from './cookie-jar';
import { AccessTokenVault, HANDLE_PREFIX, filterRequestHeaders, filterResponseHeaders, sanitizeJson, maskString, knownSet, replaceKnown, sseSanitizer, isPemPublicKey, JsonTooDeepError, MAX_JSON_DEPTH } from './sanitize';
import type { FetchLike, ServerCheck } from './server-status';

/*
 * M3 (plan v2 §2): main-process proxy for renderer requests to <scheme>://app/{api,pg}/*.
 *  - allowlisted path + method only; forwarded to the configured server origin only (origin pinned, no redirects)
 *  - Cookie comes from the main-only jar; Set-Cookie is captured there and never returned
 *  - Authorization: the renderer only ever holds an opaque handle; main swaps in the real access token
 *  - JSON responses are sanitised (auth bundle -> handle, secrets masked) before reaching the renderer
 *  - login is refused while the startup /api/status check says so (too old / not new-api / Turnstile)
 */

export const LIMITS = { requestBody: 8 << 20, responseBody: 32 << 20 } as const;
/** Endpoints that create a session: gated by the server compatibility check. */
const LOGIN_PATHS = new Set(['/api/user/login', '/api/user/login/2fa', '/api/user/login/verify', '/api/user/register', '/api/user/auth/refresh']);
const LOGOUT_PATHS = new Set(['/api/user/auth/logout', '/api/user/logout']);
/** /api/status flags for login methods the client cannot carry: hidden so upstream does not offer them. */
const STATUS_DISABLE = ['github_oauth', 'discord_oauth', 'linuxdo_oauth', 'telegram_oauth', 'wechat_login', 'oidc_enabled', 'passkey_login'];

/**
 * M4: admin endpoints whose forms round-trip secrets (channel keys, option values such as SMTP password / OAuth
 * client secrets / payment keys, custom OAuth providers, deployment credentials). The client only ever shows these
 * masked, so saving such a form would overwrite the real secret with the mask -> refused before it leaves main.
 */
// Aegis M7 2: + /api/user/setting (notification webhook_secret is round-tripped by the profile form).
export const ADMIN_SECRET_PATHS = /^\/api\/(channel|option|custom-oauth-provider|deployments|user\/setting)(\/|$)/;
export const MASKED_SAVE_MESSAGE = '该表单包含客户端掩码后的密钥（如 abcd**********wxyz），保存会用掩码覆盖服务器上的真实值，已阻止。请在服务器网页端编辑此设置。 '
  + 'This form contains secrets masked by the client; saving would overwrite the real values. Blocked — edit this setting in the server web UI.';
const MASK_LONG = /\*{10}/;                 // maskSecret() for > 8 chars: abcd**********wxyz
const MASK_SHORT = /^[^*]{2}\*{4}[^*]{2}$/; // maskSecret() for 5..8 chars (all-star masks of <= 4 chars are ambiguous, e.g. "*")

/**
 * Aegis N4 (verified against rc.46 source): `PUT /api/token` persists only name/status/expiry/quota/limits/group
 * (model.Token.Update Select list) -> the masked `key` cannot be written back; not blocked. `PUT /api/user/self`
 * (UpdateSelf: username/password/display_name) and admin `PUT /api/user` (EditWithTx: Omit access_token) never write
 * `access_token`, but do write `password` if non-empty. Upstream forms never prefill it, so as defence in depth a
 * masked/handle value in password fields is refused here (other fields, e.g. display names with stars, pass).
 */
export const USER_SAVE_PATHS = /^\/api\/user(\/self)?\/?$/;
const USER_SECRET_FIELDS = ['password', 'original_password'];
export function containsMaskedPassword(body: ArrayBuffer): boolean {
  let v: unknown;
  try { v = JSON.parse(new TextDecoder().decode(body)); } catch { return false; }
  if (!v || typeof v !== 'object') return false;
  return USER_SECRET_FIELDS.some((f) => {
    const x = (v as Record<string, unknown>)[f];
    return typeof x === 'string' && (MASK_LONG.test(x) || MASK_SHORT.test(x) || x.startsWith(HANDLE_PREFIX));
  });
}

/** True if any string in the (JSON or text) body carries our mask or an access-token handle. */
export function containsMaskedValue(body: ArrayBuffer): boolean {
  const text = new TextDecoder().decode(body);
  if (text.includes(HANDLE_PREFIX)) return true;
  let v: unknown;
  try { v = JSON.parse(text); } catch {
    // M7: non-JSON bodies (form-encoded / text): check every value token, so short masks (ab****yz) are caught too.
    const dec = (t: string) => { try { return decodeURIComponent(t.replace(/\+/g, ' ')); } catch { return t; } };
    return MASK_LONG.test(text) || text.split(/[&=\s;,]+/).some((t) => MASK_SHORT.test(dec(t)));
  }
  // Same depth limit as the response side (sanitizeJson); deeper bodies throw JsonTooDeepError (caller -> 400).
  const walk = (x: unknown, d: number): boolean => {
    if (d > MAX_JSON_DEPTH) throw new JsonTooDeepError();
    if (typeof x === 'string') {
      if (MASK_LONG.test(x) || MASK_SHORT.test(x)) return true;
      // Option values are often JSON-in-a-string (e.g. OAuth provider settings).
      if (x.length > 1 && (x[0] === '{' || x[0] === '[')) {
        let inner: unknown;
        try { inner = JSON.parse(x); } catch { return false; }
        return walk(inner, d + 1);
      }
      return false;
    }
    if (Array.isArray(x)) return x.some((e) => walk(e, d + 1));
    if (x && typeof x === 'object') return Object.values(x).some((e) => walk(e, d + 1));
    return false;
  };
  return walk(v, 0);
}

export interface ProxyRequest { method: string; url: string; headers: Headers; body: ArrayBuffer | null }
export interface ServerProxyOptions {
  getOrigin(): string | null;
  getCheck(): ServerCheck | null;
  /** Re-run the /api/status check (used before login when the cached result is missing or unreachable). */
  recheck?(): Promise<ServerCheck | null>;
  getJar(): CookieJar;
  vault: AccessTokenVault;
  fetch: FetchLike;
  timeoutMs?: number;
  /** Fired after a successful logout or a 401 on refresh (session gone). */
  onSessionCleared?(): void;
}

export function jsonResponse(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra } });
}
const fail = (status: number, code: string, message: string) => jsonResponse(status, { success: false, code, message });

export class ServerProxy {
  constructor(private readonly o: ServerProxyOptions) {}

  async handle(req: ProxyRequest): Promise<Response> {
    let u: URL;
    try { u = new URL(req.url); } catch { return fail(400, 'BAD_REQUEST', 'bad url'); }
    const canon = canonicalisePath(u.pathname); // decode-once BEFORE every decision (see canonicalisePath)
    if (!canon) return fail(400, 'BAD_REQUEST', 'bad path');
    const path = canon.path;
    const method = req.method.toUpperCase();
    const d = decide(method, path);
    if (!d.allow) return fail(d.status, d.code, d.message);

    const origin = this.o.getOrigin();
    if (!origin) return fail(503, 'NO_SERVER', '尚未配置服务器地址。');
    const target = new URL(canon.wire + u.search, origin);
    if (target.origin !== origin) return fail(400, 'BAD_REQUEST', 'origin mismatch'); // defence in depth

    // Aegis #4: match login/logout paths with trailing slashes stripped (gin redirects/accepts `/login/`).
    const bare = path.length > 1 ? path.replace(/\/+$/, '') : path;
    if (LOGIN_PATHS.has(bare) && method === 'POST') {
      let c = this.o.getCheck();
      if ((!c || c.verdict === 'unreachable') && this.o.recheck) c = await this.o.recheck();
      if (!c || !c.allowLogin) {
        return fail(403, 'LOGIN_BLOCKED', c ? c.messages.filter((m) => !m.includes('HTTPS')).join(' ') || '登录已被客户端阻止。' : '尚未完成服务器兼容性检查，请稍后重试。');
      }
    }

    if (req.body && req.body.byteLength > LIMITS.requestBody) return fail(413, 'TOO_LARGE', 'request body too large');
    if (req.body && method !== 'GET' && method !== 'HEAD' && ADMIN_SECRET_PATHS.test(path)) {
      let masked: boolean;
      try { masked = containsMaskedValue(req.body); } catch (e) {
        if (e instanceof JsonTooDeepError) return fail(400, 'TOO_DEEP', 'request JSON nested too deeply');
        throw e;
      }
      if (masked) return fail(409, 'MASKED_SECRET_SAVE_BLOCKED', MASKED_SAVE_MESSAGE);
    }
    if (req.body && method === 'PUT' && USER_SAVE_PATHS.test(path) && containsMaskedPassword(req.body)) {
      return fail(409, 'MASKED_SECRET_SAVE_BLOCKED', MASKED_SAVE_MESSAGE);
    }

    const headers: Record<string, string> = filterRequestHeaders(req.headers);
    // new-api rc.47 rejects state-changing requests (e.g. POST /api/user/auth/refresh -> 403 AUTH_ORIGIN_FORBIDDEN)
    // that carry no Origin. The renderer's own Origin (pac://app) is dropped by the header filter and main-process
    // undici fetch adds none, so send the pinned server origin (never a renderer-supplied value) on non-safe methods.
    if (method !== 'GET' && method !== 'HEAD') headers.origin = origin;
    const cookie = this.o.getJar().header(path, origin.startsWith('https://'));
    if (cookie) headers.cookie = cookie;
    const auth = req.headers.get('authorization');
    let sentToken: string | null = null;
    if (auth?.startsWith(`Bearer ${HANDLE_PREFIX}`)) {
      const real = this.o.vault.resolve(auth.slice('Bearer '.length));
      if (real) { headers.authorization = `Bearer ${real}`; sentToken = real; }
    }

    let res: Response;
    try {
      res = await this.o.fetch(target.href, {
        method, headers, redirect: 'manual', credentials: 'omit',
        body: method === 'GET' || method === 'HEAD' ? undefined : (req.body ?? undefined),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 120000),
      });
    } catch (e) {
      return fail(502, 'UPSTREAM_UNREACHABLE', `无法连接服务器：${e instanceof Error ? e.message : String(e)}`);
    }

    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    if (setCookies.length) this.o.getJar().store(setCookies, path);

    if (LOGOUT_PATHS.has(bare) && res.ok) { this.o.vault.clear(); this.o.getJar().clear(); this.o.onSessionCleared?.(); }

    const outHeaders = filterResponseHeaders(res.headers);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      let same = false;
      try { same = !!loc && new URL(loc, target).origin === origin; } catch { /* bad location */ }
      await res.body?.cancel();
      if (!same) return fail(502, 'CROSS_ORIGIN_REDIRECT', '服务器尝试重定向到其他站点，已阻止。');
      const l = new URL(loc as string, target);
      return new Response(null, { status: res.status, headers: { ...outHeaders, location: l.pathname + l.search } });
    }

    const ct = (res.headers.get('content-type') ?? '').toLowerCase();
    if (method === 'HEAD' || res.status === 204 || res.status === 304) { await res.body?.cancel(); return new Response(null, { status: res.status, headers: outHeaders }); }
    // Aegis M7 1a: known secrets = every vault token + the token sent on this request (exact-value masked everywhere).
    const known = knownSet(this.o.vault.values(), [sentToken]);
    if (ct.includes('text/event-stream')) {
      // Aegis M7 3: playground SSE carries model output, which can echo anything (prompt, upstream errors) -> sanitised
      // line by line (headers filtered).
      return new Response(res.body ? res.body.pipeThrough(sseSanitizer(known)) : null, { status: res.status, headers: outHeaders });
    }

    const buf = await readLimited(res, LIMITS.responseBody);
    if (!buf) return fail(502, 'TOO_LARGE', 'upstream response too large');
    if (ct.includes('json') || ct.startsWith('text/')) {
      const text = new TextDecoder().decode(buf);
      let parsed: unknown; let isJson = false;
      try { parsed = JSON.parse(text); isJson = true; } catch { /* not JSON */ }
      if (!isJson) return new Response(maskText(text, known), { status: res.status, headers: outHeaders });
      if (path === '/api/status' && method === 'GET') parsed = rewriteStatus(parsed);
      // The RSA public key for password encryption must reach the renderer intact (masking breaks login); public by
      // definition, so only exact known values are masked in it.
      // Only the top-level data.public_key, only if it parses as a public key.
      const top = (parsed as { data?: unknown } | null)?.data;
      const pem = path === '/api/user/login/encryption-key' ? (o: Record<string, unknown>, k: string, v: unknown) => o === top && k === 'public_key' && isPemPublicKey(v) : undefined;
      let clean: unknown;
      try { clean = sanitizeJson(parsed, this.o.vault, undefined, known, pem); } catch (e) {
        if (e instanceof JsonTooDeepError) return fail(502, 'TOO_DEEP', 'upstream JSON nested too deeply');
        throw e;
      }
      return new Response(JSON.stringify(clean), { status: res.status, headers: { ...outHeaders, 'content-type': 'application/json; charset=utf-8' } });
    }
    return new Response(buf, { status: res.status, headers: outHeaders });
  }
}

/** Non-JSON text bodies get the same secret-shape masking as JSON strings (M7: incl. raw 48-char keys, Bearer). */
const maskText = (s: string, known: readonly string[]): string => maskString(replaceKnown(s, known));

export function rewriteStatus(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body;
  const data = (body as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return body;
  const d: Record<string, unknown> = { ...(data as Record<string, unknown>) };
  for (const f of STATUS_DISABLE) if (f in d) d[f] = false;
  if (Array.isArray(d.custom_oauth_providers)) d.custom_oauth_providers = [];
  return { ...(body as object), data: d };
}

async function readLimited(res: Response, max: number): Promise<Uint8Array | null> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const parts: Uint8Array[] = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { await reader.cancel(); return null; }
    parts.push(value);
  }
  const out = new Uint8Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out;
}
