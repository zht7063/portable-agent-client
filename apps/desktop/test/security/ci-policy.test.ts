// M7: the CI workflows stay check-only (contents: read, SHA-pinned actions, no secrets / publish / deploy).
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const WF = resolve(__dirname, '../../../../.github/workflows');
const files = readdirSync(WF).filter((f) => /\.ya?ml$/.test(f));

describe('CI workflow policy', () => {
  it('there are exactly the ci and compat workflows', () => expect(files.sort()).toEqual(['ci.yml', 'compat.yml', 'installers.yml']));
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
    if (f === 'installers.yml') continue; // own rules below (it uploads LOCAL artifacts)
    it(`${f}: no secrets, publish, release, deploy, upload or repo settings`, () => {
      expect(code).not.toMatch(/secrets\.|GITHUB_TOKEN|github\.token/);
      expect(code).not.toMatch(/publish(?! never)|release|deploy|upload-artifact|gh |npm publish|pack:linux|branch.protection|pull_request_target/i);
      expect(code).toMatch(/persist-credentials: false/);
    });
    if (f !== 'ci.yml') continue;
    it(`${f}: missing web deps fail CI (PA_REQUIRE_WEB_DEPS=1) and the bundle is scanned`, () => {
      expect(code).toMatch(/PA_REQUIRE_WEB_DEPS: '1'/);
      expect(code).toContain('bun run test');
      expect(code).toContain('node scripts/scan-bundle.mjs');
      expect(code).not.toContain('test:live');
    });
  }

  describe('installers.yml (LOCAL unsigned installers, artifacts only)', () => {
    const code = readFileSync(join(WF, 'installers.yml'), 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    it('manual dispatch (+ the temporary feat/installer-only push trigger, to be removed before merge)', () => {
      expect(code).toMatch(/^on:\n {2}workflow_dispatch:\n/m);
      expect(code).not.toMatch(/^\s*(?:pull_request|pull_request_target|schedule|workflow_run|repository_dispatch):/m);
      const push = code.match(/^ {2}push:\n {4}branches: \[(.*)\]$/m);
      if (push) expect(push[1]).toBe('feat/installer');
    });
    it('no secrets/publish/release steps; only LOCAL pack scripts; unsigned; artifacts kept 7 days', () => {
      expect(code).not.toMatch(/secrets\.|GITHUB_TOKEN|github\.token|gh release|softprops|npm publish|pull_request_target/i);
      expect(code).not.toMatch(/--publish (?!never)|pack:(?:win|mac|linux)(?!:local)\b/);
      expect(code).toContain('bun run pack:win:local');
      expect(code).toContain('bun run pack:mac:local');
      expect(code).toContain("CSC_IDENTITY_AUTO_DISCOVERY: 'false'");
      expect(code).toContain('node scripts/scan-bundle.mjs');
      expect(code).toMatch(/persist-credentials: false/);
      const retention = [...code.matchAll(/retention-days: (\d+)/g)].map((m) => m[1]);
      expect(retention).toEqual(['7', '7']);
      for (const m of code.matchAll(/apps\/desktop\/release\/(\S+)/g)) expect(m[1]).toMatch(/-LOCAL\./);
    });
  });

  describe('compat.yml', () => {
    const y = readFileSync(join(WF, 'compat.yml'), 'utf8');
    const code = y.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    it('is manual-only (workflow_dispatch, no push/pull_request/schedule triggers)', () => {
      expect(code).toMatch(/^on:\n {2}workflow_dispatch:\n(?! )/m);
      expect(code).not.toMatch(/^\s*(?:push|pull_request|pull_request_target|schedule|workflow_run|repository_dispatch):/m);
    });
    it('uses the official new-api image versions from compat.json as a service and runs the /api/status check', () => {
      expect(code).toContain("jq -c '.compatMatrix.versions' compat.json");
      expect(code).toMatch(/services:\n\s+newapi:\n\s+image: \$\{\{ needs\.matrix\.outputs\.image \}\}@\$\{\{ matrix\.entry\.digest \}\}/);
      expect(code).toContain('bun run test:compat');
      expect(code).not.toContain('test:live');
      const c = JSON.parse(readFileSync(resolve(WF, '../../compat.json'), 'utf8'));
      expect(c.compatMatrix.image).toBe('calciumion/new-api');
      expect(c.compatMatrix.versions.length).toBeGreaterThan(0);
      // every image is pinned by digest (or carries an explicit TODO explaining why it is not verified yet)
      for (const v of c.compatMatrix.versions) {
        expect(v.tag).toMatch(/^v\d+\.\d+\.\d+/);
        if (!/^sha256:[0-9a-f]{64}$/.test(v.digest ?? '')) expect(String(v.todo ?? '')).toMatch(/^TODO/);
      }
    });
  });
});
