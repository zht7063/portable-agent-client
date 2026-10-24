// Aegis M6 item 6: packaging errors on unreplaced sourceUrl/sourceOffer unless PA_LOCAL_BUILD=1.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const DESKTOP = resolve(__dirname, '../..');
const req = createRequire(import.meta.url);
const { unreplacedPlaceholders, assertNoPlaceholders, sourceUrlProblem, sourceOfferProblem, assertOfficialRelease } = req(join(DESKTOP, 'scripts/check-placeholders.cjs')) as {
  sourceUrlProblem: (u: string) => string | null;
  sourceOfferProblem: (t: string) => string | null;
  assertOfficialRelease: (p: object, o: { commit?: string; fetchImpl?: (u: string, init: Record<string, unknown>) => Promise<{ status: number }> }) => Promise<void>;
  unreplacedPlaceholders: (p: object) => string[];
  assertNoPlaceholders: (p: object, env: Record<string, string | undefined>) => string | null;
};
const product = JSON.parse(readFileSync(resolve(DESKTOP, '../../packages/core/src/product.config.json'), 'utf8'));
const OFFER = 'Written offer, valid for at least three years from the date of this release: anyone may obtain the complete Corresponding Source by writing to source@portable-agent.org.';
const replaced = { sourceUrl: 'https://github.com/zht7063/portable-agent-client', sourceOffer: OFFER };

const cli = (prod: object | null, env: Record<string, string> = {}, args: string[] = []) => {
  // Runs the CLI guard against a temp copy of the repo layout so the real product config is never edited.
  const root = mkdtempSync(join(tmpdir(), 'pa-guard-'));
  try {
    mkdirSync(join(root, 'apps/desktop/scripts'), { recursive: true }); mkdirSync(join(root, 'packages/core/src'), { recursive: true });
    copyFileSync(join(DESKTOP, 'scripts/check-placeholders.cjs'), join(root, 'apps/desktop/scripts/check-placeholders.cjs'));
    writeFileSync(join(root, 'packages/core/src/product.config.json'), JSON.stringify(prod ?? product));
    return spawnSync(process.execPath, ['scripts/check-placeholders.cjs', ...args], { cwd: join(root, 'apps/desktop'), encoding: 'utf8', env: { ...process.env, PA_LOCAL_BUILD: '', ...env } });
  } finally { rmSync(root, { recursive: true, force: true }); }
};
// Decision (a) "public repo", once yubai confirms: sourceUrl kept, both dropped from $placeholders, offer text removed.
const publicRepo = { ...product, $placeholders: [], sourceUrl: 'https://github.com/zht7063/portable-agent-client', sourceOffer: undefined };

describe('official pack guard (pack:linux / pack:win / pack:mac)', () => {
  it('refuses with the current placeholder config, allows with PA_LOCAL_BUILD=1', () => {
    const r = cli(null);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('refusing to package');
    expect(cli(null, { PA_LOCAL_BUILD: '1' }).status).toBe(0);
  });
  it('passes once sourceUrl is the public repo (no placeholder listed, no placeholder offer text)', () => {
    expect(unreplacedPlaceholders(publicRepo)).toEqual([]);
    expect(cli(publicRepo).status).toBe(0);
    expect(cli({ ...publicRepo, sourceOffer: OFFER }).status).toBe(0);
  });
  it('still refuses half-done configs', () => {
    expect(cli({ ...publicRepo, $placeholders: ['sourceUrl'] }).status).toBe(1); // still listed
    expect(cli({ ...publicRepo, sourceOffer: product.sourceOffer }).status).toBe(1); // placeholder offer text would ship
    expect(cli({ ...publicRepo, sourceUrl: 'http://github.com/x/y' }).status).toBe(1); // not https
    expect(cli({ ...publicRepo, sourceUrl: '' }).status).toBe(1); // neither way to get the source
    expect(cli({ ...publicRepo, sourceUrl: null, sourceOffer: OFFER }).status).toBe(0); // decision (b)
  });
});

describe('source-offer placeholder check', () => {
  it('current product config still has the placeholders (kept on purpose)', () => {
    expect(unreplacedPlaceholders(product)).toEqual(['sourceOffer', 'sourceUrl']);
  });
  it('errors without the explicit local flag', () => {
    expect(() => assertNoPlaceholders(product, {})).toThrow(/unreplaced placeholder.*PA_LOCAL_BUILD=1/);
    expect(() => assertNoPlaceholders(product, { PA_LOCAL_BUILD: 'true' })).toThrow();
  });
  it('local build flag downgrades to a warning', () => {
    expect(assertNoPlaceholders(product, { PA_LOCAL_BUILD: '1' })).toMatch(/LOCAL build.*not for distribution/);
  });
  it('detects a PLACEHOLDER text or a still-listed field even if the other looks real', () => {
    expect(unreplacedPlaceholders({ ...replaced, $placeholders: ['sourceUrl'] })).toEqual(['sourceUrl']);
    expect(unreplacedPlaceholders({ ...replaced, sourceOffer: 'PLACEHOLDER: x' })).toEqual(['sourceOffer']);
    expect(unreplacedPlaceholders({ ...replaced, sourceUrl: '' })).toEqual([]); // the written offer alone suffices
    expect(unreplacedPlaceholders({ sourceUrl: '', sourceOffer: '' })).toEqual(['sourceOffer', 'sourceUrl']);
    expect(assertNoPlaceholders(replaced, {})).toBeNull();
  });
  it('electron-builder config itself fails to load without the flag and loads with it', () => {
    const load = (env: Record<string, string>) => spawnSync(process.execPath, ['-e', "require('./electron-builder.config.cjs')"], {
      cwd: DESKTOP, encoding: 'utf8', env: { ...process.env, PA_LOCAL_BUILD: '', ...env },
    });
    const bad = load({});
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain('unreplaced placeholder');
    expect(load({ PA_LOCAL_BUILD: '1' }).status).toBe(0);
  });
  it('only the LOCAL pack scripts set the flag; official ones explicitly clear it and run the --official guard first', () => {
    const scripts = JSON.parse(readFileSync(join(DESKTOP, 'package.json'), 'utf8')).scripts as Record<string, string>;
    const GUARD = 'PA_LOCAL_BUILD=0 node scripts/check-placeholders.cjs --official && ';
    for (const [name, cmd] of Object.entries(scripts)) {
      if (!cmd.includes('electron-builder')) continue;
      const builders = cmd.split('&&').filter((c) => c.includes('electron-builder'));
      if (name === 'pack:dir' || name.endsWith(':local')) {
        for (const b of builders) expect(b.trim().startsWith('PA_LOCAL_BUILD=1 electron-builder')).toBe(true);
        expect(cmd).not.toContain('check-placeholders');
      } else {
        expect(['pack:linux', 'pack:win', 'pack:mac']).toContain(name);
        expect(cmd.startsWith(GUARD)).toBe(true); // refuse before building, inherited PA_LOCAL_BUILD=1 overridden
        for (const b of builders) expect(b.trim().startsWith('PA_LOCAL_BUILD=0 electron-builder')).toBe(true);
        expect(cmd.replace(/PA_LOCAL_BUILD=1/g, '')).not.toMatch(/PA_LOCAL_BUILD=1/);
        expect(scripts[`${name}:local`]).toBe(cmd.slice(GUARD.length).replace(/PA_LOCAL_BUILD=0 electron-builder/g, 'PA_LOCAL_BUILD=1 electron-builder'));
      }
    }
  });
  it('pack:mac stages and packages each arch separately (declared deps match the bundled arch)', () => {
    const scripts = JSON.parse(readFileSync(join(DESKTOP, 'package.json'), 'utf8')).scripts as Record<string, string>;
    for (const n of ['pack:mac', 'pack:mac:local']) {
      const steps = scripts[n]!.split('&&').map((s) => s.trim());
      for (const a of ['arm64', 'x64']) {
        const st = steps.indexOf(`PA_TARGET_PLATFORM=darwin PA_TARGET_ARCH=${a} node scripts/stage.mjs`);
        expect(st).toBeGreaterThan(-1);
        expect(steps[st + 1]).toMatch(new RegExp(`electron-builder .*--mac dmg --${a} `));
      }
      expect(scripts[n]).not.toMatch(/PA_TARGET_ARCH=[\w-]+,/);
    }
  });
});

describe('Aegis round 3: source URL / offer rules and official reachability check', () => {
  it('URL: only allowlisted public hosts, no userinfo/IP/localhost/reserved TLDs/TODO', () => {
    for (const ok of ['https://github.com/zht7063/portable-agent-client', 'https://gitlab.com/a/b', 'https://codeberg.org/a/b']) expect(sourceUrlProblem(ok)).toBeNull();
    for (const bad of ['https://example.org/src', 'https://evil.com/a/b', 'https://user:pass@github.com/a/b', 'https://tok@github.com/a/b',
      'https://127.0.0.1/a/b', 'https://[::1]/a/b', 'https://localhost/a/b', 'https://foo.localhost/a/b', 'https://repo.example/a/b',
      'https://repo.invalid/a/b', 'https://repo.test/a/b', 'https://github.com/TODO/repo', 'https://github.com/owner/TBD', 'https://github.com/owner',
      'http://github.com/a/b', 'https://github.com:8443/a/b', 'https://github.com/<owner>/<repo>', 'not a url']) expect(sourceUrlProblem(bad), bad).not.toBeNull();
  });
  it('placeholder regex catches TODO, TBD, FIXME, place-holder, <...>', () => {
    for (const t of ['TODO', 'tbd', 'FIXME', 'place-holder', 'Place holder', '<contact email>']) {
      expect(sourceOfferProblem(`${OFFER} ${t}`), t).toBe('placeholder text');
      expect(unreplacedPlaceholders({ $placeholders: [], sourceUrl: '', sourceOffer: `${OFFER} ${t}` })).toEqual(['sourceOffer', 'sourceUrl']);
    }
  });
  it('offer: minimum length, validity period and contact required', () => {
    expect(sourceOfferProblem(OFFER)).toBeNull();
    expect(sourceOfferProblem('Email source@portable-agent.org, valid for three years.')).toMatch(/shorter/);
    expect(sourceOfferProblem(OFFER.replace('valid for at least three years from the date of this release', 'offered by the authors of this release software'))).toMatch(/validity/);
    expect(sourceOfferProblem(OFFER.replace('source@portable-agent.org', 'the authors of the project at their office'))).toMatch(/contact/);
  });
  const C = 'a'.repeat(40);
  it('official check: anonymous GET <sourceUrl>/tree/<commit> must return 200 (injectable fetch)', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const f = (status: number) => async (u: string, init: Record<string, unknown>) => { calls.push([u, init]); return { status }; };
    await expect(assertOfficialRelease(publicRepo, { commit: C, fetchImpl: f(200) })).resolves.toBeUndefined();
    expect(calls[0]![0]).toBe(`https://github.com/zht7063/portable-agent-client/tree/${C}`);
    expect(calls[0]![1]).toMatchObject({ method: 'GET', redirect: 'manual', credentials: 'omit' });
    expect(JSON.stringify(calls[0]![1])).not.toMatch(/authorization|cookie/i);
    for (const s of [404, 301, 302, 401, 500]) await expect(assertOfficialRelease(publicRepo, { commit: C, fetchImpl: f(s) })).rejects.toThrow(`HTTP ${s}`);
    await expect(assertOfficialRelease(publicRepo, { commit: C, fetchImpl: async () => { throw new Error('offline'); } })).rejects.toThrow(/offline/);
    await expect(assertOfficialRelease(publicRepo, { commit: `${C}-dirty`, fetchImpl: f(200) })).rejects.toThrow(/build commit/);
    await expect(assertOfficialRelease(product, { commit: C, fetchImpl: f(200) })).rejects.toThrow(/unreplaced/);
    // written offer only (decision b): no URL to fetch
    calls.length = 0;
    await expect(assertOfficialRelease({ $placeholders: [], sourceOffer: OFFER }, { commit: C, fetchImpl: f(404) })).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });
  it('official CLI ignores an inherited PA_LOCAL_BUILD=1', () => {
    const r = cli(null, { PA_LOCAL_BUILD: '1', PA_BUILD_COMMIT: C }, ['--official']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('refusing to package');
    expect(cli({ ...publicRepo, $placeholders: [] }, { PA_BUILD_COMMIT: `${C}-dirty` }, ['--official']).status).toBe(1);
  });
});
