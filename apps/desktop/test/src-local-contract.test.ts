import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBridge } from '../src/preload/bridge';

/** src-local/lib/pa-types.ts hand-mirrors the bridge (the vendored web build cannot import @pac/core). Keep them in sync. */
const ROOT = resolve(__dirname, '../../..');
const mirror = readFileSync(resolve(ROOT, 'src-local/lib/pa-types.ts'), 'utf8');

function mirrorMethods(): Record<string, string[]> {
  const body = mirror.slice(mirror.indexOf('export interface PaBridge'));
  const out: Record<string, string[]> = {};
  for (const m of body.matchAll(/^ {2}(\w+): \{([^\n]*)\}$|^ {2}(\w+): \{\n([\s\S]*?)^ {2}\}/gm)) {
    const name = m[1] ?? m[3] ?? ''; const inner = m[2] ?? m[4] ?? '';
    out[name] = [...inner.matchAll(/(\w+)\(/g)].map((x) => x[1] ?? '').sort();
  }
  return out;
}

describe('src-local contract mirror', () => {
  it('lists exactly the bridge namespaces and methods', () => {
    const b = createBridge({ invoke: async () => ({}), on: () => {}, removeListener: () => {} }) as unknown as Record<string, unknown>;
    const real: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(b)) if (v && typeof v === 'object') real[k] = Object.keys(v).sort();
    expect(mirrorMethods()).toEqual(real);
    expect(mirror).toContain('onSessionChanged(');
  });

  it('mirror carries no credential-bearing field names', () => {
    expect(mirror).not.toMatch(/\b(fullKey|rawKey|accessToken|access_token|cookie|password)\b/i);
  });
});
