import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('check-asar release artifact selection', () => {
  it('checks only top-level swift-client-*.exe/*.dmg, never helper exes in win-unpacked', async () => {
    // @ts-expect-error JS build policy tool has no declarations.
    const { releaseArtifacts } = await import('../../../../scripts/check-asar.mjs') as { releaseArtifacts(dir: string): string[] };
    const dir = mkdtempSync(join(tmpdir(), 'swift-rel-'));
    try {
      for (const f of ['swift-client-0.1.0-beta.3-win-x64.exe', 'swift-client-0.1.0-beta.3-mac-arm64.dmg', 'swift-client-0.1.0-beta.3-win-x64.exe.sha256', 'other.exe', 'builder-debug.yml']) writeFileSync(join(dir, f), '');
      mkdirSync(join(dir, 'win-unpacked/resources'), { recursive: true });
      writeFileSync(join(dir, 'win-unpacked/resources/elevate.exe'), '');
      writeFileSync(join(dir, 'win-unpacked/swift-client.exe'), '');
      mkdirSync(join(dir, 'swift-client-dir.exe'));
      expect(releaseArtifacts(dir)).toEqual([join(dir, 'swift-client-0.1.0-beta.3-mac-arm64.dmg'), join(dir, 'swift-client-0.1.0-beta.3-win-x64.exe')]);
      expect(releaseArtifacts(join(dir, 'missing'))).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('treats zero matched installers (or a missing explicit path) as an error', async () => {
    // @ts-expect-error JS build policy tool has no declarations.
    const { selectArtifacts } = await import('../../../../scripts/check-asar.mjs') as { selectArtifacts(args: string[], dir: string): string[] };
    const dir = mkdtempSync(join(tmpdir(), 'swift-rel-'));
    try {
      mkdirSync(join(dir, 'win-unpacked/resources'), { recursive: true });
      writeFileSync(join(dir, 'win-unpacked/resources/elevate.exe'), '');
      expect(() => selectArtifacts([], dir)).toThrow(/no release artifacts/);
      expect(() => selectArtifacts([], join(dir, 'missing'))).toThrow(/no release artifacts/);
      expect(() => selectArtifacts([join(dir, 'nope.exe')], dir)).toThrow(/no release artifacts/);
      writeFileSync(join(dir, 'swift-client-0.1.0-beta.3-win-x64.exe'), '');
      expect(selectArtifacts([], dir)).toEqual([join(dir, 'swift-client-0.1.0-beta.3-win-x64.exe')]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
