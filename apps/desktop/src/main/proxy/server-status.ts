/*
 * M3: startup compatibility check (plan v2 §4). Public GET <server>/api/status, no credentials, no redirects.
 * Result is cached in main only.
 */
export interface CompatRange { tag: string; minServer: string; maxServerTested: string | null; policy: 'same-minor-line' | 'exact' }

export type Verdict =
  | 'ok'            // in range
  | 'untested'      // newer than tested: warn, allow
  | 'too-old'       // block login
  | 'incompatible'  // other major.minor line (same-minor-line) / not the pin (exact): block login, needs a new pin
  | 'not-new-api'   // unparseable / not a new-api /api/status: block login
  | 'unreachable';  // network error: block login until a retry succeeds

export interface ServerCheck {
  verdict: Verdict;
  allowLogin: boolean;
  serverVersion: string | null;
  systemName: string | null;
  insecureTransport: boolean;
  /** Login features enabled on the server that this client cannot carry (Turnstile, OAuth providers, passkey). */
  unsupported: string[];
  /** Turnstile makes password login impossible through the proxy (widget script is blocked by CSP). */
  turnstile: boolean;
  messages: string[];
  checkedAt: number;
}

const VERSION = /^v(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.(\d+))?$/;
export function parseVersion(v: unknown) {
  const m = VERSION.exec(String(v ?? ''));
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? ([m[4], Number(m[5])] as [string, number]) : null } : null;
}
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) throw new Error(`invalid version: ${!x ? a : b}`);
  for (const k of ['major', 'minor', 'patch'] as const) if (x[k] !== y[k]) return x[k] - y[k];
  if (!x.pre || !y.pre) return (x.pre ? -1 : 0) - (y.pre ? -1 : 0);
  return x.pre[0] !== y.pre[0] ? (x.pre[0] < y.pre[0] ? -1 : 1) : x.pre[1] - y.pre[1];
}

/**
 * Plan §4 + compat.json policy (same semantics as scripts/compat-check.mjs serverCompat; a test keeps them in sync):
 *  older than minServer → too-old; `exact`: anything but the pin → incompatible;
 *  `same-minor-line`: other major.minor than the pin → incompatible (needs a new pin);
 *  same line ≤ maxServerTested (or pin) → ok; newer on the same line → untested (warn + allow).
 */
export function classify(c: CompatRange, version: unknown): Verdict {
  const s = parseVersion(version);
  if (!s) return 'not-new-api';
  const v = String(version);
  if (compareVersions(v, c.minServer) < 0) return 'too-old';
  if (c.policy === 'exact') return compareVersions(v, c.tag) === 0 ? 'ok' : 'incompatible';
  const t = parseVersion(c.tag);
  if (!t || s.major !== t.major || s.minor !== t.minor) return 'incompatible';
  return compareVersions(v, c.maxServerTested ?? c.tag) <= 0 ? 'ok' : 'untested';
}

const OAUTH_FLAGS: [string, string][] = [
  ['github_oauth', 'GitHub'], ['discord_oauth', 'Discord'], ['linuxdo_oauth', 'LinuxDO'], ['telegram_oauth', 'Telegram'],
  ['wechat_login', 'WeChat'], ['oidc_enabled', 'OIDC'], ['passkey_login', 'Passkey'],
];

export function evaluateStatus(c: CompatRange, origin: string, body: unknown, now = Date.now()): ServerCheck {
  const insecureTransport = !origin.startsWith('https://');
  const data = (body && typeof body === 'object' && (body as { success?: unknown }).success === true)
    ? (body as { data?: Record<string, unknown> }).data : undefined;
  const ok = !!data && typeof data === 'object';
  const version = ok ? data.version : undefined;
  const verdict = ok ? classify(c, version) : 'not-new-api';
  const turnstile = ok && data.turnstile_check === true;
  const unsupported = ok ? OAUTH_FLAGS.filter(([f]) => data[f] === true).map(([, n]) => n) : [];
  if (ok && Array.isArray(data.custom_oauth_providers) && data.custom_oauth_providers.length) unsupported.push('custom OAuth');
  const messages: string[] = [];
  if (verdict === 'too-old') messages.push(`服务器版本 ${String(version)} 低于客户端支持的最低版本 ${c.minServer}，已阻止登录。请升级服务器或使用匹配的客户端版本。`);
  if (verdict === 'not-new-api') messages.push('该地址未返回 new-api 的 /api/status（或版本号无法解析），已阻止登录。请检查服务器地址。');
  if (verdict === 'incompatible') messages.push(`服务器版本 ${String(version)} 不在客户端支持的版本线内（${c.policy === 'exact' ? `仅支持 ${c.tag}` : `${c.tag.replace(/^(v\d+\.\d+)\..*$/, '$1')}.x，≥ ${c.minServer}`}），已阻止登录。请使用与服务器匹配的客户端版本。`);
  if (verdict === 'untested') messages.push(`服务器版本 ${String(version)} 高于客户端已测试的版本 ${c.maxServerTested ?? c.tag}，部分功能可能异常。`);
  if (turnstile) messages.push('服务器启用了 Turnstile 人机验证，桌面客户端暂不支持，无法在客户端内登录。');
  if (unsupported.length) messages.push(`服务器启用的 ${unsupported.join('、')} 登录方式在客户端内不可用，请使用用户名密码登录。`);
  if (insecureTransport) messages.push('服务器未使用 HTTPS：密码与会话将以明文传输，仅在可信网络中使用。');
  const allowLogin = (verdict === 'ok' || verdict === 'untested') && !turnstile;
  return {
    verdict, allowLogin, serverVersion: typeof version === 'string' ? version : null,
    systemName: ok && typeof data.system_name === 'string' ? data.system_name : null,
    insecureTransport, unsupported, turnstile, messages, checkedAt: now,
  };
}

export function unreachable(origin: string, err: unknown, now = Date.now()): ServerCheck {
  return {
    verdict: 'unreachable', allowLogin: false, serverVersion: null, systemName: null,
    insecureTransport: !origin.startsWith('https://'), unsupported: [], turnstile: false,
    messages: [`无法连接服务器 ${origin}：${err instanceof Error ? err.message : String(err)}`], checkedAt: now,
  };
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** GET /api/status with no cookies/authorization, manual redirects, timeout. */
export async function checkServer(c: CompatRange, origin: string, fetchImpl: FetchLike, timeoutMs = 10000): Promise<ServerCheck> {
  try {
    const res = await fetchImpl(`${origin}/api/status`, {
      method: 'GET', redirect: 'manual', credentials: 'omit', headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status !== 200) return evaluateStatus(c, origin, null);
    const text = await res.text();
    if (text.length > 1 << 20) return evaluateStatus(c, origin, null);
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { /* not new-api */ }
    return evaluateStatus(c, origin, body);
  } catch (e) {
    return unreachable(origin, e);
  }
}
