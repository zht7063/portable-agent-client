/*
 * M3 (plan v2 §2): endpoint allowlist for the main-process server proxy.
 * Derived from new-api v1.0.0-rc.46 router/api-router.go (+ channel-router.go, relay-router.go /pg).
 * Deny-by-default: anything not matched here never leaves the machine.
 */

export type Method = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
const ALL: Method[] = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];
const READ: Method[] = ['GET', 'HEAD'];

export interface Rule { re: RegExp; methods: Method[] }
export type Decision =
  | { allow: true }
  | { allow: false; status: 403 | 405; code: string; message: string };

/** Explicitly refused paths (checked first) with a user-facing reason. */
export const DENY: { re: RegExp; code: string; message: string }[] = [
  // OAuth / third-party login redirects bounce through the system browser and back to the *server's* web UI,
  // which cannot hand a session to this client. Unsupported in M3 (plan §2, §9.3).
  { re: /^\/api\/oauth\/(?!email\/)/, code: 'OAUTH_UNSUPPORTED', message: '桌面客户端暂不支持第三方（OAuth）登录/绑定，请使用用户名密码登录，或在浏览器中访问服务器网页完成该操作。' },
  // Server-to-server callbacks: never from a desktop client.
  { re: /^\/api\/(creem|stripe|waffo|waffo-pancake)\/webhook(\/|$)/, code: 'FORBIDDEN', message: 'webhook endpoints are not reachable from the client' },
  // WebAuthn is bound to the server's RP ID; the app:// origin cannot satisfy it.
  { re: /^\/api\/user\/(login\/passkey|passkey\/login)\//, code: 'PASSKEY_UNSUPPORTED', message: '桌面客户端暂不支持通行密钥（Passkey）登录，请使用用户名密码登录。' },
  { re: /^\/api\/user\/epay\/notify$/, code: 'FORBIDDEN', message: 'payment callbacks are not reachable from the client' },
  { re: /^\/api\/subscription\/epay\/(notify|return)$/, code: 'FORBIDDEN', message: 'payment callbacks are not reachable from the client' },
];

/** Top-level /api segments the upstream frontend uses (any method; server-side auth still applies). */
const API_SEGMENTS = [
  'user', 'token', 'channel', 'log', 'usage', 'redemption', 'option', 'group', 'prefill_group', 'models', 'vendors',
  'subscription', 'custom-oauth-provider', 'perf-metrics', 'performance', 'ratio_sync', 'plugin', 'task_plugin_options',
  'system-task', 'system-info', 'data', 'mj', 'task', 'deployments', 'audit', 'setup', 'verify', 'verification',
  'oauth', // only /api/oauth/email/* survives DENY
];
const API_READ_ONLY = [
  'status', 'about', 'notice', 'home_page_content', 'pricing', 'privacy-policy', 'user-agreement', 'rankings',
  'ratio_config', 'uptime', 'midjourney', 'reset_password',
];

export const RULES: Rule[] = [
  { re: new RegExp(`^/api/(${API_SEGMENTS.map(esc).join('|')})(/|$)`), methods: ALL },
  { re: new RegExp(`^/api/(${API_READ_ONLY.map(esc).join('|')})(/|$)`), methods: READ },
  // Playground (session-authenticated chat; SSE). /v1, /mj relay need API keys -> never via the renderer.
  { re: /^\/pg\/(chat\/completions|images\/generations|responses)$/, methods: ['POST'] },
];

function esc(s: string) { return s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&'); }

/** Path must already be normalised (see normalisePath). */
export function decide(method: string, path: string): Decision {
  for (const d of DENY) if (d.re.test(path)) return { allow: false, status: 403, code: d.code, message: d.message };
  const m = method.toUpperCase() as Method;
  let matched = false;
  for (const r of RULES) {
    if (!r.re.test(path)) continue;
    matched = true;
    if (r.methods.includes(m)) return { allow: true };
  }
  return matched
    ? { allow: false, status: 405, code: 'METHOD_NOT_ALLOWED', message: `method ${m} not allowed for ${path}` }
    : { allow: false, status: 403, code: 'NOT_ALLOWLISTED', message: `path not allowed by the client proxy: ${path}` };
}

/** Rejects anything that could change the target outside the plain path (traversal, encoded separators, //host). */
export function normalisePath(pathname: string): string | null {
  if (!pathname.startsWith('/') || pathname.startsWith('//')) return null;
  if (/[\\\0]|%2f|%5c|%00|%2e/i.test(pathname)) return null;
  if (pathname.split('/').some((s) => s === '..' || s === '.')) return null;
  return pathname;
}
