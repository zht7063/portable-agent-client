// Aegis M6 item 3: missing web deps -> clear skip (exit 0); PA_REQUIRE_WEB_DEPS=1 -> failure.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../../..');
const fake = mkdtempSync(join(tmpdir(), 'pa-lp-'));
mkdirSync(join(fake, 'scripts'));
copyFileSync(join(ROOT, 'scripts/test-local-pages.sh'), join(fake, 'scripts/test-local-pages.sh'));
afterAll(() => rmSync(fake, { recursive: true, force: true }));

const run = (env: Record<string, string>) =>
  spawnSync('bash', [join(fake, 'scripts/test-local-pages.sh'), '--no-install'], {
    encoding: 'utf8', env: { ...process.env, PA_REQUIRE_WEB_DEPS: '', ...env },
  });

describe('test-local-pages without web deps', () => {
  it('skips with a clear message by default', () => {
    const r = run({});
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('local-pages: SKIPPED');
    expect(r.stderr).toContain('bun run install:web');
  });
  it('fails when PA_REQUIRE_WEB_DEPS=1 (CI)', () => {
    const r = run({ PA_REQUIRE_WEB_DEPS: '1' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('local-pages: FAIL');
  });
});
