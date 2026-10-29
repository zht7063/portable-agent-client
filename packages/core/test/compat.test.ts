import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
// @ts-expect-error plain .mjs script without types
import { compareVersions, serverCompat, validateCompat } from '../../../scripts/compat-check.mjs';

const compat = JSON.parse(readFileSync(new URL('../../../compat.json', import.meta.url), 'utf8'));

describe('compat.json (upstream pin)', () => {
  it('is valid and pins new-api v1.0.0-rc.46', () => {
    expect(validateCompat(compat)).toEqual([]);
    expect(compat.tag).toBe('v1.0.0-rc.46');
  });
  it('treats server v1.0.0-rc.47 as tested (live-verified 2026-10-28) while the pin stays rc.46', () => {
    expect(compat.minServer).toBe('v1.0.0-rc.46');
    expect(compat.maxServerTested).toBe('v1.0.0-rc.47');
    expect(compareVersions(compat.maxServerTested, compat.tag)).toBeGreaterThan(0);
    expect(compat.compatMatrix.versions.map((v: { tag: string }) => v.tag)).toEqual(['v1.0.0-rc.46', 'v1.0.0-rc.47']);
  });
  it('orders versions incl. prereleases', () => {
    expect(compareVersions('v1.0.0-rc.9', 'v1.0.0-rc.46')).toBeLessThan(0);
    expect(compareVersions('v1.0.0', 'v1.0.0-rc.46')).toBeGreaterThan(0);
    expect(compareVersions('v0.9.9', 'v1.0.0-rc.1')).toBeLessThan(0);
  });
  it('server window: same minor line, warn above tested', () => {
    expect(serverCompat(compat, 'v1.0.0-rc.46')).toBe('ok');
    expect(serverCompat(compat, 'v1.0.0-rc.45')).toBe('too-old');
    expect(serverCompat(compat, 'v1.0.0-rc.47')).toBe('ok');
    expect(serverCompat(compat, 'v1.0.0-rc.48')).toBe('untested');
    expect(serverCompat(compat, 'v1.0.0')).toBe('untested');
    expect(serverCompat(compat, 'v1.1.0')).toBe('incompatible');
    expect(serverCompat(compat, 'garbage')).toBe('incompatible');
  });
  it('rejects malformed pins', () => {
    expect(validateCompat({ ...compat, commit: 'abc' }).length).toBeGreaterThan(0);
    expect(validateCompat({ ...compat, minServer: 'v9.0.0' })).toContain('minServer must not be newer than the pinned tag');
  });
});
