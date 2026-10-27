import { describe, it, expect } from 'vitest';
import { rm } from 'node:fs/promises';
import { fixture } from './v6-fixture.js';

describe('cleartext HTTP apply warning (Aegis R41 P4)', () => {
  it.each(['codex', 'claude'] as const)('%s plan warns for http and not for https', async (id) => {
    for (const [origin, warns] of [['http://203.0.113.5:3000', true], ['https://api.example-prod.com', false]] as const) {
      const s = await fixture(origin);
      try {
        const plan = await s.harness.plan(id, s.profile.id);
        expect(plan.warnings.some((w) => w.includes('cleartext'))).toBe(warns);
      } finally { await rm(s.root, { recursive: true, force: true }); }
    }
  });
});
