import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { consumeUninstallNonce } from '../src/main/detach-all';
describe('S17 uninstall cleanup guard', () => {
  it('refuses ordinary/unpackaged calls and consumes an installer nonce once', async () => {
    const data = await mkdtemp(join(tmpdir(), 'swift-uninstall-')); await mkdir(join(data, 'harness'));
    const args = ['swift-client', '--harness-detach-all'];
    expect(await consumeUninstallNonce(true, args, data)).toBe(false);
    await writeFile(join(data, 'harness/uninstall.nonce'), 'swift-uninstall:123');
    expect(await consumeUninstallNonce(false, args, data)).toBe(false);
    expect(await consumeUninstallNonce(true, ['swift-client'], data)).toBe(false);
    expect(await consumeUninstallNonce(true, args, data)).toBe(true);
    expect(await consumeUninstallNonce(true, args, data)).toBe(false);
  });
});
