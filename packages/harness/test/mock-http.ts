import type { FetchLike } from '@pac/core';

export interface Call { method: string; path: string; headers: Record<string, string>; body: unknown }
type Handler = (call: Call) => Response | Promise<Response>;

/** Tiny route-based fetch mock (no network). Routes: "METHOD /path" (query ignored unless included). */
export function mockFetch(routes: Record<string, Handler | Handler[]>) {
  const calls: Call[] = [];
  const counters: Record<string, number> = {};
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const call: Call = { method, path: url.pathname + url.search, headers, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    if (init?.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const key = [`${method} ${url.pathname}${url.search}`, `${method} ${url.pathname}`].find((k) => routes[k]);
    if (!key) return new Response('not found', { status: 404 });
    const r = routes[key]!;
    const n = (counters[key] = (counters[key] ?? 0) + 1);
    const h = Array.isArray(r) ? r[Math.min(n - 1, r.length - 1)]! : r;
    return h(call);
  };
  return { fetch, calls };
}

export const json = (body: unknown, init: ResponseInit & { cookies?: string[] } = {}): Response => {
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const c of init.cookies ?? []) headers.append('set-cookie', c);
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
};
export const ok = (data?: unknown, init?: ResponseInit & { cookies?: string[] }): Response => json({ success: true, message: '', ...(data !== undefined ? { data } : {}) }, init);
export const fail = (message: string, status = 200): Response => json({ success: false, message }, { status });
