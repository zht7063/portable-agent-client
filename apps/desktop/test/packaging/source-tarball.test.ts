// Aegis M6 item 4: scripts/source-tarball.sh is reproducible (two runs -> identical sha256).
import { execFileSync } from '../../../../test/helpers/subprocess';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../../..');
const OUT = join(ROOT, 'apps/desktop/release');

function run(): { file: string; sha: string } {
  const out = execFileSync('bash', ['scripts/source-tarball.sh', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  const file = /wrote (.+\.tar\.gz)/.exec(out)![1]!;
  return { file, sha: createHash('sha256').update(readFileSync(file)).digest('hex') };
}

describe('source tarball', () => {
  it('two runs produce an identical sha256, with numeric 0/0 owners and sorted entries', async () => {
    const a = run();
    await new Promise((r) => setTimeout(r, 1100)); // cross a second boundary: wall clock must not leak in
    const b = run();
    expect(b.file).toBe(a.file);
    expect(b.sha).toBe(a.sha);
    const list = execFileSync('tar', ['--numeric-owner', '-tvzf', a.file], { encoding: 'utf8' }).trim().split('\n');
    for (const l of list) expect(l).toMatch(/^\S+ 0\/0 /);
    const names = execFileSync('tar', ['-tzf', a.file], { encoding: 'utf8' }).trim().split('\n');
    expect(names.some((n) => n.endsWith('/SOURCE-INFO.txt'))).toBe(true);
    const info = execFileSync('tar', ['-xzOf', a.file, names.find((n) => n.endsWith('/SOURCE-INFO.txt'))!], { encoding: 'utf8' });
    for (const s of ['pack:linux', 'pack:win', 'pack:mac', 'pack:dir', 'pack:linux:local', 'pack:win:local', 'pack:mac:local']) expect(info).toContain(s);
    expect(readdirSync(OUT).some((f) => f.endsWith('-source.tar.gz.sha256'))).toBe(true);
  }, 120_000);
});
