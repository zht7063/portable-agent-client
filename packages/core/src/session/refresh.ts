import { PaException } from '../contract/errors.js';
import type { StoredSession } from '../contract/session.js';
import type { HttpClient, NewApiEnvelope } from '../http/client.js';
import { unwrap } from '../http/client.js';
import { cookieHeader, readSetCookie } from './cookie.js';
import type { DefaultSessionManager, RefreshResult } from './manager.js';

/**
 * Session refresh (POST /api/user/auth/refresh with the stored refresh cookie), kept from f2049d8's auth module.
 * Login/register/logout UI moved to the upstream frontend; M3 reworks this into the main-only proxy session.
 */
export interface LoginData {
  access_token?: string;
  token_type?: string;
  access_expires_at?: number;
  session?: { sid?: string; expires_at?: number };
  user?: { id: number; username: string };
}

/** Converts a login/refresh response into a session (throws on missing fields). */
export function toRefreshResult(baseUrl: string, data: LoginData, cookie: string | null, prev?: StoredSession): RefreshResult {
  if (!data?.access_token || !data.access_expires_at) {
    throw new PaException({ code: 'VALIDATION', message: 'Additional verification required (2FA/challenge not supported yet)' });
  }
  const refreshCookie = cookie ?? prev?.refreshCookie;
  if (!refreshCookie) throw new PaException({ code: 'SERVER', message: 'Server did not set refresh cookie' });
  const user = data.user ?? (prev ? { id: prev.userId, username: prev.username } : undefined);
  if (!user) throw new PaException({ code: 'SERVER', message: 'Missing user in login response' });
  return {
    accessToken: data.access_token,
    accessExpiresAt: data.access_expires_at,
    stored: {
      serverUrl: baseUrl,
      refreshCookie,
      sid: data.session?.sid ?? prev?.sid,
      userId: user.id,
      username: user.username,
      sessionExpiresAt: data.session?.expires_at ?? prev?.sessionExpiresAt,
    },
  };
}

export function installRefresher(http: HttpClient, session: DefaultSessionManager): void {
  session.setRefresher(async (stored) => {
    const headers: Record<string, string> = { Cookie: cookieHeader(stored.refreshCookie) };
    if (stored.sid) headers['X-Auth-Session'] = stored.sid;
    const res = await http.send('POST', '/api/user/auth/refresh', { auth: 'none', headers });
    const data = unwrap(await res.json() as NewApiEnvelope<LoginData>, res.status);
    return toRefreshResult(http.baseUrl, data, readSetCookie(res.headers), stored);
  });
}
