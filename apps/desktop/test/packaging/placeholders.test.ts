// Aegis M6 item 6: packaging errors on unreplaced sourceUrl/sourceOffer unless PA_LOCAL_BUILD=1.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const DESKTOP = resolve(__dirname, '../..');
const req = createRequire(import.meta.url);
const { unreplacedPlaceholders, assertNoPlaceholders } = req(join(DESKTOP, 'scripts/check-placeholders.cjs')) as {
  unreplacedPlaceholders: (p: object) => string[];
  assertNoPlaceholders: (p: object, env: Record<string, string | undefined>) => string | null;
};
const product = JSON.parse(readFileSync(resolve(DESKTOP, '../../packages/core/src/product.config.json'), 'utf8'));
const replaced = { sourceUrl: 'https://example.org/src', sourceOffer: 'Source at https://example.org/src' };

const cli = (prod: object | null, env: Record<string, string> = {}) => {
  // Runs the CLI guard against a temp copy of the repo layout so the real product config is never edited.
  const root = mkdtempSync(join(tmpdir(), 'pa-guard-'));
  try {
    mkdirSync(join(root, 'apps/desktop/scripts'), { recursive: true }); mkdirSync(join(root, 'packages/core/src'), { recursive: true });
    copyFileSync(join(DESKTOP, 'scripts/check-placeholders.cjs'), join(root, 'apps/desktop/scripts/check-placeholders.cjs'));
    writeFileSync(join(root, 'packages/core/src/product.config.json'), JSON.stringify(prod ?? product));
    return spawnSync(process.execPath, ['scripts/check-placeholders.cjs'], { cwd: join(root, 'apps/desktop'), encoding: 'utf8', env: { ...process.env, PA_LOCAL_BUILD: '', ...env } });
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
    expect(cli({ ...publicRepo, sourceOffer: 'Source: https://github.com/zht7063/portable-agent-client' }).status).toBe(0);
  });
  it('still refuses half-done configs', () => {
    expect(cli({ ...publicRepo, $placeholders: ['sourceUrl'] }).status).toBe(1); // still listed
    expect(cli({ ...publicRepo, sourceOffer: product.sourceOffer }).status).toBe(1); // placeholder offer text would ship
    expect(cli({ ...publicRepo, sourceUrl: 'http://github.com/x/y' }).status).toBe(1); // not https
    expect(cli({ ...publicRepo, sourceUrl: '' }).status).toBe(1); // neither way to get the source
    expect(cli({ ...publicRepo, sourceUrl: null, sourceOffer: 'Written offer: email source@example.org for the source.' }).status).toBe(0); // decision (b)
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
  it('only the LOCAL pack scripts set the flag', () => {
    const scripts = JSON.parse(readFileSync(join(DESKTOP, 'package.json'), 'utf8')).scripts as Record<string, string>;
    for (const [name, cmd] of Object.entries(scripts)) {
      if (cmd.includes('electron-builder')) {
        if (name === 'pack:dir' || name.endsWith(':local')) expect(cmd).toContain('PA_LOCAL_BUILD=1 electron-builder');
        else {
          expect(['pack:linux', 'pack:win', 'pack:mac']).toContain(name);
          expect(cmd).not.toContain('PA_LOCAL_BUILD');
          expect(cmd.startsWith('node scripts/check-placeholders.cjs && ')).toBe(true); // refuse before building
          expect(scripts[`${name}:local`]).toBe(cmd.replace('node scripts/check-placeholders.cjs && ', '').replace('electron-builder', 'PA_LOCAL_BUILD=1 electron-builder'));
        }
      }
    }
  });
});
