import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readFile, stat } from 'node:fs/promises';

/*
 * M2: privileged custom protocol serving the bundled (patched) new-api web build (plan v2 §1.2/§2).
 * Pure, electron-free logic lives here so it is unit-testable; index.ts wires it into protocol.handle.
 *  - read-only, confined to the renderer directory (path traversal / encoded separators / NUL rejected)
 *  - SPA fallback to index.html for extension-less routes
 *  - strict CSP + hardening headers on every response
 *  - /api/* (and other server paths) go to the M3 main-process proxy when one is supplied (else 503 stub)
 */

export const APP_HOST = 'app';

export function appOrigin(scheme: string): string { return `${scheme}://${APP_HOST}`; }

export function buildCsp(scheme: string): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${scheme}:`,
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function securityHeaders(scheme: string): Record<string, string> {
  return {
    'Content-Security-Policy': buildCsp(scheme),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), usb=(), serial=(), hid=(), bluetooth=()',
  };
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm',
};
export const mimeFor = (p: string) => MIME[extname(p).toLowerCase()] ?? 'application/octet-stream';

/** Paths that belong to the new-api server, not the bundle. M3 proxies /api via main; others stay blocked. */
export const SERVER_PATH = /^\/(api|v1|mj|pg)(\/|$)/;

export type Resolved =
  | { kind: 'file'; path: string }
  | { kind: 'spa' }           // serve index.html (client-side route)
  | { kind: 'server' }        // /api/* etc. → main-process proxy (M3)
  | { kind: 'reject'; status: 400 | 403 | 404 };

/**
 * Map a request URL to a file under `root`. Never returns a path outside `root`.
 * Rejects foreign scheme/host, encoded slashes/backslashes, NUL, `..` segments (raw or decoded).
 */
export function resolveRequest(rawUrl: string, root: string, scheme: string): Resolved {
  let u: URL;
  try { u = new URL(rawUrl); } catch { return { kind: 'reject', status: 400 }; }
  if (u.protocol !== `${scheme}:` || u.host !== APP_HOST) return { kind: 'reject', status: 403 };
  const rawPath = u.pathname;
  if (/%2f|%5c|%00/i.test(rawPath) || rawPath.includes('\\')) return { kind: 'reject', status: 400 };
  let path: string;
  try { path = decodeURIComponent(rawPath); } catch { return { kind: 'reject', status: 400 }; }
  if (path.includes('\0')) return { kind: 'reject', status: 400 };
  const segs = path.split('/');
  if (segs.some((s) => s === '..' || s === '.')) return { kind: 'reject', status: 400 };
  if (SERVER_PATH.test(path)) return { kind: 'server' };
  const rel = segs.filter(Boolean).join(sep);
  if (!rel) return { kind: 'spa' };
  const absRoot = resolve(root);
  const target = resolve(absRoot, rel);
  const r = relative(absRoot, target);
  if (r === '' || r.startsWith('..') || isAbsolute(r)) return { kind: 'reject', status: 403 };
  // Extension-less paths are client routes (TanStack Router, browser history).
  if (!extname(rel)) return { kind: 'spa' };
  return { kind: 'file', path: target };
}

export interface FsLike { readFile(p: string): Promise<Buffer | Uint8Array>; isFile(p: string): Promise<boolean> }
export const nodeFs: FsLike = {
  readFile: (p) => readFile(p),
  isFile: async (p) => { try { return (await stat(p)).isFile(); } catch { return false; } },
};

export const M2_API_STUB = { success: false, message: 'not implemented in M2: the /api proxy lands in M3', code: 'NOT_IMPLEMENTED' };

/** Build the protocol response. Only GET/HEAD are served; everything carries the security headers. */
/** Server-path handler (M3: the main-process proxy). Without one, server paths get the 503 stub. */
export type ServerHandler = (req: { url: string; method: string }) => Promise<Response>;

export async function handleAppRequest(req: { url: string; method: string }, root: string, scheme: string, fs: FsLike = nodeFs, server?: ServerHandler): Promise<Response> {
  const base = securityHeaders(scheme);
  const text = (status: number, body: string) => new Response(body, { status, headers: { ...base, 'Content-Type': 'text/plain; charset=utf-8' } });
  const r = resolveRequest(req.url, root, scheme);
  if (r.kind === 'reject') return text(r.status, r.status === 404 ? 'Not found' : r.status === 403 ? 'Forbidden' : 'Bad request');
  if (r.kind === 'server') {
    if (server) {
      const res = await server(req);
      // Proxy output never carries Set-Cookie (stripped in the proxy); CSP/hardening headers are re-applied here.
      const h = new Headers(res.headers);
      h.delete('set-cookie');
      for (const [k, v] of Object.entries(base)) h.set(k, v);
      return new Response(res.body, { status: res.status, headers: h });
    }
    return new Response(JSON.stringify(M2_API_STUB), { status: 503, headers: { ...base, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return text(405, 'Method not allowed');
  const file = r.kind === 'file' ? r.path : join(resolve(root), 'index.html');
  if (!(await fs.isFile(file))) return text(404, 'Not found');
  const body = req.method === 'HEAD' ? null : await fs.readFile(file);
  return new Response(body as ConstructorParameters<typeof Response>[0], { status: 200, headers: { ...base, 'Content-Type': mimeFor(file), 'Cache-Control': 'no-cache' } });
}

/** Navigation guard: the window may only ever show our app origin. */
export function isAppUrl(url: string, scheme: string): boolean {
  try { const u = new URL(url); return u.protocol === `${scheme}:` && u.host === APP_HOST; } catch { return false; }
}

/** Links that may be handed to the OS browser (after confirmation): http(s) only, no credentials in URL. */
export function externalUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password) return null;
    return u.href;
  } catch { return null; }
}

export type NavDecision = { action: 'allow' } | { action: 'deny' } | { action: 'external'; url: string };
/** will-navigate / window.open policy: in-app navigation allowed, http(s) → OS browser, everything else denied. */
export function navigationDecision(url: string, scheme: string, kind: 'navigate' | 'open'): NavDecision {
  if (isAppUrl(url, scheme)) return kind === 'navigate' ? { action: 'allow' } : { action: 'deny' };
  const ext = externalUrl(url);
  return ext ? { action: 'external', url: ext } : { action: 'deny' };
}
