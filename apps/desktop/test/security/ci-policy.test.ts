// M7: the CI workflows stay check-only (contents: read, SHA-pinned actions, no secrets / publish / deploy).
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const WF = resolve(__dirname, '../../../../.github/workflows');
const files = readdirSync(WF).filter((f) => /\.ya?ml$/.test(f));

describe('CI workflow policy', () => {
  it('there are exactly the ci, compat, installers and release-build workflows', () => expect(files.sort()).toEqual(['ci.yml', 'compat.yml', 'installers.yml', 'release-build.yml']));
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
    if (f === 'installers.yml' || f === 'release-build.yml') continue; // own rules below (they upload artifacts)
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
    it(`${f}: asserts that --official refuses (placeholder fixture, wrong PA_BUILD_COMMIT, dirty tree)`, () => {
      expect(code).toContain("refuse 'unreplaced placeholder' env PA_LOCAL_BUILD=1 node scripts/check-placeholders.cjs --official");
      expect(code).toContain("refuse 'does not match git HEAD' env PA_BUILD_COMMIT=0000000000000000000000000000000000000000 node scripts/check-placeholders.cjs --official");
      expect(code).toContain("refuse 'working tree is dirty' node scripts/check-placeholders.cjs --official");
    });
  }

  describe('installers.yml (LOCAL unsigned installers, artifacts only)', () => {
    const code = readFileSync(join(WF, 'installers.yml'), 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    it('manual dispatch only (no push or other automatic trigger)', () => {
      expect(code).toMatch(/^on:\n {2}workflow_dispatch:\n(?! )/m);
      expect(code).not.toMatch(/^\s*(?:push|pull_request|pull_request_target|schedule|workflow_run|repository_dispatch|workflow_call):/m);
      expect(readFileSync(join(WF, 'installers.yml'), 'utf8')).not.toMatch(/\bpush:/);
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
      // pinned runner images, integrity-checked x64 keyring (no --force), ad-hoc signature verified
      expect([...code.matchAll(/runs-on: (\S+)/g)].map((m) => m[1])).toEqual(['windows-2025', 'macos-14']);
      expect(code).not.toMatch(/--force\b/);
      expect(code).toMatch(/test "\$got" = "\$lock"/);
      expect(code).toContain('codesign --verify --deep --strict');
      expect(code).toContain("grep -q 'Signature=adhoc'");
    });
  });

  describe('release-build.yml (OFFICIAL installers, artifacts only, guard refuses until the repo is public)', () => {
    const code = readFileSync(join(WF, 'release-build.yml'), 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    it('manual dispatch only', () => {
      expect(code).toMatch(/^on:\n {2}workflow_dispatch:\n(?! )/m);
      expect(code).not.toMatch(/^\s*(?:push|pull_request|pull_request_target|schedule|workflow_run|repository_dispatch|workflow_call):/m);
    });
    it('official pack scripts (which run the --official guard first); no secrets/publish/release; artifacts 7 days', () => {
      expect(code).not.toMatch(/secrets\.|GITHUB_TOKEN|github\.token|gh release|softprops|npm publish|--publish (?!never)|:local\b|PA_LOCAL_BUILD=1/i);
      expect(code).toContain('bun run pack:win\n');
      expect(code).toContain('bun run pack:mac\n');
      const scripts = JSON.parse(readFileSync(resolve(WF, '../../apps/desktop/package.json'), 'utf8')).scripts as Record<string, string>;
      for (const n of ['pack:win', 'pack:mac']) expect(scripts[n]!.startsWith('PA_LOCAL_BUILD=0 node scripts/check-placeholders.cjs --official && ')).toBe(true);
      expect(code).toContain("CSC_IDENTITY_AUTO_DISCOVERY: 'false'");
      expect(code).toContain('node scripts/scan-bundle.mjs');
      expect(code).toMatch(/persist-credentials: false/);
      expect([...code.matchAll(/retention-days: (\d+)/g)].map((m) => m[1])).toEqual(['7', '7']);
      expect([...code.matchAll(/runs-on: (\S+)/g)].map((m) => m[1])).toEqual(['windows-2025', 'macos-14']);
      expect(code).not.toMatch(/--force\b/);
      expect(code).toContain('codesign --verify --deep --strict');
      expect(code).toContain("grep -q 'Signature=adhoc'");
      expect(code).toMatch(/sha256sum/); expect(code).toMatch(/shasum -a 256/);
      for (const m of code.matchAll(/apps\/desktop\/release\/(\S+)/g)) expect(m[1]).toMatch(/^swift-client-\*\.(exe|dmg)(\.sha256)?$/);
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
