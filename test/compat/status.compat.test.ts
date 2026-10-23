/**
 * M7 compat matrix: the client's public /api/status compatibility check against an official new-api Docker image.
 * Credential-free (GET /api/status only). Run by the manual-only .github/workflows/compat.yml, or locally:
 *   PAC_COMPAT_SERVER=http://127.0.0.1:3000 PAC_COMPAT_EXPECT=v1.0.0-rc.46 bun run test:compat
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkServer, classify, type CompatRange } from '../../apps/desktop/src/main/proxy/server-status';

const server = process.env.PAC_COMPAT_SERVER;
const expected = process.env.PAC_COMPAT_EXPECT;
const compat = JSON.parse(readFileSync(new URL('../../compat.json', import.meta.url), 'utf8')) as CompatRange & { compatMatrix: { versions: string[] } };

describe.skipIf(!server)('compat: /api/status against an official new-api image', () => {
  it('the image version is listed in compat.json', () => {
    expect(compat.compatMatrix.versions).toContain(expected);
  });
  it('the client accepts the server (verdict, version, login allowed)', async () => {
    const origin = new URL(server!).origin;
    const check = await checkServer(compat, origin, (u, i) => fetch(u, i));
    console.info(`compat: server ${check.serverVersion} -> ${check.verdict}`);
    expect(check.serverVersion).toBe(expected);
    expect(check.verdict).toBe(classify(compat, expected));
    expect(['ok', 'untested']).toContain(check.verdict);
    expect(check.allowLogin).toBe(true);
  });
});
