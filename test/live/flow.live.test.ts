/**
 * Live smoke against a real new-api server. NEVER runs by default and is read-only (no login, no key, no writes).
 * Enable: PAC_LIVE=1 PAC_SERVER_URL=https://your-new-api.example bun run test:live
 * The login/session/key live flow is reintroduced with the M3 main-only proxy session.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { MemoryTokenStore, createCore } from '@pac/core';

const live = process.env.PAC_LIVE === '1' && !!process.env.PAC_SERVER_URL;

describe.skipIf(!live)('live new-api smoke (read-only)', () => {
  it('GET /api/status reports a server version and the compat policy is evaluated', async () => {
    const core = createCore({ serverUrl: process.env.PAC_SERVER_URL!, store: new MemoryTokenStore() });
    const status = await core.http.api<{ version?: string }>('GET', '/api/status');
    expect(typeof status.version).toBe('string');
    const compat = JSON.parse(readFileSync(new URL('../../compat.json', import.meta.url), 'utf8')) as { tag: string };
    console.info(`server ${status.version}; client pinned to ${compat.tag}`);
  });
});
