import { describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseToml, codexProvider } from '@pac/harness';
import { findCredentialLeaks } from '@pac/core';
import { fixture, CANARY } from './v6-fixture.js';
describe('Codex v6', () => {
  it('writes swift bearer provider and separate profile, preserves defaults and never reads auth.json', async () => {
    const s = await fixture(); await mkdir(s.codex.dir);
    const original = '# keep\nmodel = "user-model"\nmodel_provider = "openai"\n\n[mcp_servers.x]\ncommand = "npx"\n';
    await writeFile(s.codex.configPath, original);
    await writeFile(s.codex.authPath, 'not even JSON');
    const plan = await s.harness.plan('codex', s.profile.id);
    expect(findCredentialLeaks(plan)).toEqual([]); expect(JSON.stringify(plan)).not.toContain(CANARY);
    await s.harness.apply('codex', plan);
    const text = await readFile(s.codex.configPath, 'utf8');
    const config = parseToml(text);
    expect(config.model).toBe('user-model'); expect(config.model_provider).toBe('openai');
    expect(config.model_providers).toEqual({ swift: codexProvider(s.profile, CANARY) });
    expect(text).toContain('# managed by swift-client provider=swift-test v=2\n[model_providers.swift]');
    expect(parseToml(await readFile(join(s.codex.dir, 'swift.config.toml'), 'utf8'))).toEqual({ model: 'test-codex', model_provider: 'swift' });
    expect(await readFile(s.codex.authPath, 'utf8')).toBe('not even JSON');
    expect(JSON.stringify(await s.state.load())).not.toContain(CANARY);
    expect((await s.harness.plan('codex', s.profile.id)).changes.every((c) => c.kind === 'unchanged')).toBe(true);
    await s.harness.rollback('codex', 'detach');
    expect(await readFile(s.codex.configPath, 'utf8')).not.toContain(CANARY);
    expect((await s.harness.rollback('codex', 'detach')).written).toEqual([]);
  });
  it('setDefault is opt-in and legacy pa auth is removed only by explicit apply', async () => {
    const s = await fixture(); await mkdir(s.codex.dir);
    await writeFile(s.codex.configPath, '[model_providers.pa]\nname="Portable Agent"\n[model_providers.pa.auth]\ncommand="/old/helper"\n');
    await s.harness.upsertProfile({ ...s.profile, codex: { setDefault: true } });
    const plan = await s.harness.plan('codex', s.profile.id);
    expect(await readFile(s.codex.configPath, 'utf8')).toContain('pa.auth');
    await s.harness.apply('codex', plan, plan.conflicts.map((c) => ({ conflictId: c.id, resolution: 'overwrite' })));
    const config = parseToml(await readFile(s.codex.configPath, 'utf8'));
    expect(config.model_provider).toBe('swift'); expect(config.model_providers).not.toHaveProperty('pa');
    expect(JSON.stringify(config)).not.toContain('auth');
  });
  it('refuses unsafe dotted provider definitions without touching disk', async () => {
    const s = await fixture(); await mkdir(s.codex.dir);
    const original = 'model_providers.swift.base_url = "https://user.invalid"\n';
    await writeFile(s.codex.configPath, original);
    const p = await s.harness.plan('codex', s.profile.id);
    await expect(s.harness.apply('codex', p, p.conflicts.map((c) => ({ conflictId: c.id, resolution: 'overwrite' })))).rejects.toThrow();
    expect(await readFile(s.codex.configPath, 'utf8')).toBe(original);
  });
});
