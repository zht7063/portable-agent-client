import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from '../../../../test/helpers/subprocess';

const root = join(__dirname, '../../../..');
const app = join(root, 'apps/desktop');
describe('S15 final own-module artifact policy', () => {
  it('passes production build and refuses changed origin, URL env reads and smoke markers', async () => {
    // @ts-expect-error JS build policy tool has no declarations.
    const { inspect } = await import('../../../../scripts/check-asar.mjs') as { inspect(path: string): void };
    const temp = mkdtempSync(join(tmpdir(), 'swift-artifact-'));
    try {
      const out = join(temp, 'dist');
      const build = spawnSync(process.execPath, ['scripts/build-main.mjs', '--prod'], { cwd: app, env: { ...process.env, PA_OUT_DIR: out }, encoding: 'utf8' });
      expect(build.status).toBe(0);
      expect(() => inspect(temp)).not.toThrow();
      const path = join(out, 'main/index.cjs'); const good = readFileSync(path, 'utf8');
      writeFileSync(path, good.replaceAll('https://api.swift-client.invalid', 'https://foreign.invalid'));
      expect(() => inspect(temp)).toThrow(/origin/);
      writeFileSync(path, good + '\n// src/main/index.ts\nconst leakedOrigin = process.env.EVIL_URL;\n');
      expect(() => inspect(temp)).toThrow(/environment/);
      writeFileSync(path, good + '\n/* PA_SMOKE */'); expect(() => inspect(temp)).toThrow(/smoke/);
      writeFileSync(path, good);
      // Validate strict config:set field snapshot against a deliberately compromised artifact.
      writeFileSync(path, good.replace('"config:set": ["clipboardClearSeconds"]', '"config:set": ["clipboardClearSeconds", "serverUrl"]'));
      expect(() => inspect(temp)).toThrow(/IPC/);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
});
