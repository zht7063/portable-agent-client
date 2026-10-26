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
      for (const access of ["process['env'].EVIL_URL", "process['env']['EVIL_URL']", "globalThis.process.env.X"]) {
        writeFileSync(path, good + `\n// src/main/index.ts\nconst leaked = ${access};\n`);
        expect(() => inspect(temp)).toThrow(/environment/);
      }
      for (const value of ["'ht'+'tps://foreign.invalid'", "'//foreign.invalid'", "'wss://foreign.invalid'", "'ws://foreign.invalid'"]) {
        writeFileSync(path, good + `\n// src/main/index.ts\nconst url = ${value};\n`);
        expect(() => inspect(temp)).toThrow(/foreign URL/);
      }
      for (const code of ['const p = process; p.env.X;', 'const {env} = process; env.X;', 'const e = process.env; e.X;', 'const {EVIL_URL} = process.env;']) {
        writeFileSync(path, good + `\n// src/main/index.ts\n${code}\n`);
        expect(() => inspect(temp)).toThrow(/environment/);
      }
      // File+literal allowlist: another index module and aliases in our entry must be rejected.
      const metaPath = join(out, 'metafile.json');
      const metaText = readFileSync(metaPath, 'utf8');
      const meta = JSON.parse(metaText);
      const output = Object.values(meta.main.outputs).find((x) => (x as { entryPoint?: string }).entryPoint) as { inputs: Record<string, { bytesInOutput: number }> };
      output.inputs['src/untrusted/index.ts'] = { bytesInOutput: 50 };
      meta.main.inputs['src/untrusted/index.ts'] = { imports: [] };
      writeFileSync(metaPath, JSON.stringify(meta));
      writeFileSync(path, good + '\n// src/untrusted/index.ts\nconst alias = process.env;\n');
      expect(() => inspect(temp)).toThrow(/environment alias/);
      writeFileSync(path, good);
      expect(() => inspect(temp)).toThrow(/coverage.*src\/untrusted\/index.ts/);
      writeFileSync(metaPath, metaText);
      const missingMeta = JSON.parse(metaText);
      const ownModule = Object.keys(missingMeta.main.inputs).find((p) => p.startsWith('src/main/'))!;
      delete missingMeta.main.inputs[ownModule];
      writeFileSync(metaPath, JSON.stringify(missingMeta));
      expect(() => inspect(temp)).toThrow(/missing from metafile/);
      writeFileSync(metaPath, metaText);
      writeFileSync(path, good + '\n// src/main/index.ts\nconst alias = process.env;\n');
      expect(() => inspect(temp)).toThrow(/environment alias/);
      writeFileSync(path, good + '\n// src/main/index.ts\nconst url = `https://foreign.invalid`;\n');
      expect(() => inspect(temp)).toThrow(/foreign URL/);
      writeFileSync(path, good + '\n// src/main/index.ts\nconst url = `https://${host}/path`;\n');
      expect(() => inspect(temp)).toThrow(/foreign URL/);
      writeFileSync(path, good + '\n/* PA_SMOKE */'); expect(() => inspect(temp)).toThrow(/smoke/);
      writeFileSync(path, good);
      // Validate strict config:set field snapshot against a deliberately compromised artifact.
      writeFileSync(path, good.replace('"config:set": ["clipboardClearSeconds"]', '"config:set": ["clipboardClearSeconds", "serverUrl"]'));
      expect(() => inspect(temp)).toThrow(/IPC/);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
});
