// Aegis M6 item 6: packaging errors on unreplaced sourceUrl/sourceOffer unless PA_LOCAL_BUILD=1.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
    expect(unreplacedPlaceholders({ ...replaced, sourceUrl: '' })).toEqual(['sourceUrl']);
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
        expect(['pack:dir', 'pack:linux']).toContain(name);
        expect(cmd).toContain('PA_LOCAL_BUILD=1 electron-builder');
      }
    }
  });
});
