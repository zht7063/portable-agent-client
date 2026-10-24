export * from './contract/index.js';
export { MemoryTokenStore } from './session/stores/memory.js';
export { DefaultSessionManager, systemClock, REFRESH_SKEW_S, type Clock, type Refresher, type RefreshResult } from './session/manager.js';
export { readSetCookie, cookieHeader, REFRESH_COOKIE } from './session/cookie.js';
export { installRefresher, toRefreshResult, type LoginData } from './session/refresh.js';
export { HttpClient, redact, unwrap, type FetchLike, type NewApiEnvelope } from './http/client.js';
export * from './keys/index.js';
export { normalizeServerUrl, isInsecureServerUrl } from './config.js';

import type { TokenStore } from './contract/session.js';
import { DefaultSessionManager, type Clock } from './session/manager.js';
import { HttpClient, type FetchLike } from './http/client.js';
import { createKeys, MemoryKeyVault, type KeyVault } from './keys/index.js';
import { normalizeServerUrl } from './config.js';
import { installRefresher } from './session/refresh.js';

/**
 * No default server: the URL of the (standard) new-api deployment is always user-configured.
 * Login/billing/chat/token-management UI is provided by the upstream new-api frontend (M2+);
 * the session manager here is the base for the main-only proxy session (M3).
 */
export interface CoreOptions { serverUrl: string; store: TokenStore; vault?: KeyVault; fetch?: FetchLike; clock?: Clock; timeoutMs?: number }

export function createCore(opts: CoreOptions) {
  const serverUrl = normalizeServerUrl(opts.serverUrl);
  const http = new HttpClient({ baseUrl: serverUrl, fetch: opts.fetch, timeoutMs: opts.timeoutMs });
  const session = new DefaultSessionManager({ store: opts.store, serverUrl, clock: opts.clock });
  http.setAuthProvider(session);
  installRefresher(http, session);
  return { serverUrl, http, session, keys: createKeys(http, opts.vault ?? new MemoryKeyVault()) };
}
export type Core = ReturnType<typeof createCore>;
export { PRODUCT, type ProductConfig } from './product.js';
