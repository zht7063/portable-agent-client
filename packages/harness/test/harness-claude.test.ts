import { describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { claudeBaseUrl, claudeManagedPaths } from '@pac/harness';
import { fixture, CANARY } from './v6-fixture.js';
describe('Claude v6', () => {
  it('writes AUTH_TOKEN, models and marker, removes old helper, preserves unrelated settings', async () => {
    const s = await fixture(); await mkdir(s.claude.dir);
    await writeFile(s.claude.settingsPath, '{"apiKeyHelper":"/old/helper", "permissions":{"allow":["Read"]}}');
    const plan = await s.harness.plan('claude', s.profile.id);
    expect(JSON.stringify(plan)).not.toContain(CANARY);
    await s.harness.apply('claude', plan, plan.conflicts.map((c) => ({ conflictId: c.id, resolution: 'overwrite' })));
    const j = JSON.parse(await readFile(s.claude.settingsPath, 'utf8'));
    expect(j.apiKeyHelper).toBeUndefined(); expect(j.permissions.allow).toEqual(['Read']);
    expect(j.env).toMatchObject({ ANTHROPIC_AUTH_TOKEN: CANARY, ANTHROPIC_BASE_URL: s.profile.serverUrl, ANTHROPIC_MODEL: 'test-main', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'test-small', ANTHROPIC_CUSTOM_MODEL_OPTION: 'test-custom', SWIFT_CLIENT_MANAGED: s.profile.id });
    expect(j.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(JSON.stringify(await s.state.load())).not.toContain(CANARY);
    await s.harness.rollback('claude', 'detach');
    expect(await readFile(s.claude.settingsPath, 'utf8')).not.toContain(CANARY);
  });
  it('permits preview but refuses apply while a model is a placeholder', async () => {
    const s = await fixture(); await s.harness.upsertProfile({ ...s.profile, models: { main: 'claude-main-placeholder', small: 'claude-small-placeholder' } });
    const p = await s.harness.plan('claude', s.profile.id);
    expect(p.warnings.join()).toContain('pending');
    await expect(s.harness.apply('claude', p)).rejects.toThrow(/placeholder/);
  });
  it('uses origin without v1 and current managed paths', () => {
    expect(claudeBaseUrl('https://a.invalid/v1/')).toBe('https://a.invalid');
    expect(claudeManagedPaths('win32')[0]).toBe('C:\\Program Files\\ClaudeCode\\managed-settings.json');
  });
});
