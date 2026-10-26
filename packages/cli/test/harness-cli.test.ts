import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHarness } from '../src/commands/harness.js';
import { FileKeyVault } from '../src/stores/file.js';
import { PRODUCT } from '@pac/core';
describe('D15 dev-only CLI harness vault', () => {
  it('uses its own FileKeyVault; writes masked previews and explicit apply, never desktop storage', async () => {
    const home = await mkdtemp(join(tmpdir(), 'swift-cli-')); const outputs: unknown[] = [];
    const data = join(home, '.config', PRODUCT.cliConfigDir);
    const key = 'sk-CLI-TEST-CANARY-' + 'C'.repeat(32);
    await new FileKeyVault(join(data, 'keys.json')).set(7, key);
    const profile = join(home, 'profile.json');
    await writeFile(profile, JSON.stringify({ id: 'default', serverUrl: 'https://test.invalid', keyId: 7, models: { main: 'test' }, keyMode: 'plaintext' }));
    const call = (args: string[]) => runHarness([...args, '--home', home], { env: { HOME: home }, out: (v) => outputs.push(v), err: () => {}, platform: 'linux', exec: async () => ({ code: null, stdout: '', stderr: '' }) });
    expect(await call(['profile', 'set', profile])).toBe(0);
    expect(await call(['key-check', 'default', 'codex'])).toBe(0);
    expect(await call(['apply', 'codex'])).toBe(1);
    expect(await call(['apply', 'codex', '--yes'])).toBe(0);
    expect(JSON.stringify(outputs)).not.toContain(key);
    expect(await readFile(join(home, '.codex/config.toml'), 'utf8')).toContain(key);
    expect(await call(['rollback', 'codex', '--detach', '--yes'])).toBe(0);
    expect(await readFile(join(home, '.codex/config.toml'), 'utf8')).not.toContain(key);
  });
  it('rejects relative HOME and unknown harness', async () => {
    expect(await runHarness(['detect', '--home', 'rel'], { out: () => {}, err: () => {} })).toBe(1);
    const home = await mkdtemp(join(tmpdir(), 'swift-cli-'));
    await expect(runHarness(['plan', 'gemini', '--home', home], { out: () => {}, err: () => {} })).rejects.toThrow(/harness/);
  });
});
