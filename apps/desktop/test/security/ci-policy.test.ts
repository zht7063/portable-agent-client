// M7: the CI workflow stays check-only (contents: read, SHA-pinned actions, no secrets / publish / deploy).
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const WF = resolve(__dirname, '../../../../.github/workflows');
const files = readdirSync(WF).filter((f) => /\.ya?ml$/.test(f));

describe('CI workflow policy', () => {
  it('there is exactly the ci workflow', () => expect(files).toEqual(['ci.yml']));
  for (const f of files) {
    const y = readFileSync(join(WF, f), 'utf8');
    const code = y.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    it(`${f}: top-level permissions contents: read only`, () => {
      expect(code).toMatch(/^permissions:\n {2}contents: read\n(?! )/m);
      expect(code).not.toMatch(/:\s*write\b|write-all/);
    });
    it(`${f}: every action pinned to a full commit SHA`, () => {
      const uses = [...code.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]!);
      expect(uses.length).toBeGreaterThan(0);
      for (const u of uses) expect(u).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    });
    it(`${f}: no secrets, publish, release, deploy, upload or repo settings`, () => {
      expect(code).not.toMatch(/secrets\.|GITHUB_TOKEN|github\.token/);
      expect(code).not.toMatch(/publish(?! never)|release|deploy|upload-artifact|gh |npm publish|pack:linux|branch.protection|pull_request_target/i);
      expect(code).toMatch(/persist-credentials: false/);
    });
    it(`${f}: missing web deps fail CI (PA_REQUIRE_WEB_DEPS=1) and the bundle is scanned`, () => {
      expect(code).toMatch(/PA_REQUIRE_WEB_DEPS: '1'/);
      expect(code).toContain('bun run test');
      expect(code).toContain('node scripts/scan-bundle.mjs');
      expect(code).not.toContain('test:live');
    });
  }
});
