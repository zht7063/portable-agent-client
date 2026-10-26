import { describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HarnessMigration } from '../src/main/harness-migration';
import { fixture } from '../../../packages/harness/test/v6-fixture';

describe('beta.1 startup self-check', () => {
  it('plans without writes or secret disclosure; confirmed migration strips old references and helper', async () => {
    const s = await fixture();
    try {
      await mkdir(s.claude.dir, { recursive: true }); await mkdir(s.codex.dir, { recursive: true });
      await mkdir(join(s.data, 'bin'), { recursive: true });
      const helper = join(s.data, 'bin/pa-key'); await writeFile(helper, 'obsolete executable');
      const original = '{"apiKeyHelper":"/old/pa-key secret-value","env":{"KEEP":"yes","OLD":"!/old/pa-key","ANTHROPIC_BASE_URL":"https://old.invalid","ANTHROPIC_MODEL":"old","ANTHROPIC_DEFAULT_OPUS_MODEL":"old","ANTHROPIC_DEFAULT_SONNET_MODEL":"old","ANTHROPIC_DEFAULT_HAIKU_MODEL":"old"}}';
      await writeFile(s.claude.settingsPath, original);
      await writeFile(s.codex.configPath, 'model_provider="pa"\nmodel="mine"\n[model_providers.pa]\nname="old"\n[model_providers.pa.auth]\ncommand="pa-key"\n');
      await s.state.upsertProfile({ ...s.profile, providerId: 'pa' });
      const migration = new HarnessMigration(s.fs, s.state, s.env);
      const plan = await migration.plan();
      expect(plan.needsMigration).toBe(true);
      expect(JSON.stringify(plan)).not.toContain('secret-value');
      expect(await readFile(s.claude.settingsPath, 'utf8')).toBe(original);
      expect(await readFile(helper, 'utf8')).toBe('obsolete executable');
      await migration.apply(plan);
      expect(JSON.parse(await readFile(s.claude.settingsPath, 'utf8'))).toEqual({ env: { KEEP: 'yes' } });
      expect(await readFile(s.codex.configPath, 'utf8')).toBe('');
      await expect(readFile(helper)).rejects.toThrow();
      expect((await s.state.load()).profiles).toEqual({});
      expect((await migration.plan()).needsMigration).toBe(false);
    } finally { await rm(s.root, { recursive: true, force: true }); }
  });

  it.each(['pa-key', `printf '%s' "$PA_API_KEY"`])('fully detaches beta helper %s and restores owned originals', async (helper) => {
    const s = await fixture();
    try {
      await mkdir(s.claude.dir, { recursive: true });
      await mkdir(s.codex.dir, { recursive: true });
      await writeFile(s.claude.settingsPath, JSON.stringify({ apiKeyHelper: helper, env: { KEEP: 'yes', ANTHROPIC_BASE_URL: 'https://old.invalid', ANTHROPIC_MODEL: 'old', ANTHROPIC_DEFAULT_OPUS_MODEL: 'old' } }));
      await writeFile(s.codex.configPath, 'model="old"\nmodel_provider="pa"\n[model_providers.pa]\nname="old"\n');
      const claudeFile = (await s.fs.readText(s.claude.settingsPath))!;
      const codexFile = (await s.fs.readText(s.codex.configPath))!;
      await s.state.update((st) => {
        st.profiles[s.profile.id] = { ...s.profile, providerId: 'pa' };
        for (const [path, harness, ownedSettings, original] of [
          [s.claude.settingsPath, 'claude', ['apiKeyHelper', 'env.ANTHROPIC_BASE_URL', 'env.ANTHROPIC_MODEL', 'env.ANTHROPIC_DEFAULT_OPUS_MODEL'], { 'env.ANTHROPIC_MODEL': 'user-model' }],
          [s.codex.configPath, 'codex', ['model', 'model_provider', 'model_providers.pa'], { model: 'user-model' }],
        ] as const) st.files[path] = { harness, profileId: s.profile.id, ownedSettings: [...ownedSettings], original, ownedValuesHash: 'old', lastWritten: harness === 'claude' ? claudeFile.fingerprint : codexFile.fingerprint, updatedAt: '' };
      });
      const migration = new HarnessMigration(s.fs, s.state, s.env);
      expect((await migration.plan()).files).toContain(s.claude.settingsPath);
      await migration.apply(await migration.plan());
      expect(JSON.parse(await readFile(s.claude.settingsPath, 'utf8'))).toEqual({ env: { KEEP: 'yes', ANTHROPIC_MODEL: 'user-model' } });
      expect(await readFile(s.codex.configPath, 'utf8')).toBe('model = "user-model"\n');
      expect((await migration.plan()).needsMigration).toBe(false);
    } finally { await rm(s.root, { recursive: true, force: true }); }
  });

  it.each([['command', '/data/bin/pa-key'], ['env', `printf '%s' "$PA_API_KEY"`]])('beta.1 %s-mode null originals restore to absent keys (r39 N5)', async (_mode, helper) => {
    const s = await fixture();
    try {
      await mkdir(s.claude.dir, { recursive: true });
      await mkdir(s.codex.dir, { recursive: true });
      // Shape written by beta.1 (d0af9fd) apply: originals are null for keys that did not exist before.
      await writeFile(s.claude.settingsPath, JSON.stringify({ apiKeyHelper: helper, env: { KEEP: '1', ANTHROPIC_BASE_URL: 'https://old.invalid', ANTHROPIC_MODEL: 'pa-model', ANTHROPIC_DEFAULT_OPUS_MODEL: 'pa-model', ANTHROPIC_DEFAULT_SONNET_MODEL: 'pa-model', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'pa-model' } }));
      await writeFile(s.codex.configPath, 'model="pa-model"\nmodel_provider="pa"\n[model_providers.pa]\nname="old"\n');
      const claudeFile = (await s.fs.readText(s.claude.settingsPath))!;
      const codexFile = (await s.fs.readText(s.codex.configPath))!;
      const claudeKeys = ['apiKeyHelper', 'env.ANTHROPIC_BASE_URL', 'env.ANTHROPIC_MODEL', 'env.ANTHROPIC_DEFAULT_OPUS_MODEL', 'env.ANTHROPIC_DEFAULT_SONNET_MODEL', 'env.ANTHROPIC_DEFAULT_HAIKU_MODEL'];
      await s.state.update((st) => {
        st.profiles[s.profile.id] = { ...s.profile, providerId: 'pa' };
        st.files[s.claude.settingsPath] = { harness: 'claude', profileId: s.profile.id, ownedSettings: claudeKeys, original: { ...Object.fromEntries(claudeKeys.map((k) => [k, null])), 'env.ANTHROPIC_MODEL': 'user-own' } as never, ownedValuesHash: 'old', lastWritten: claudeFile.fingerprint, updatedAt: '' };
        st.files[s.codex.configPath] = { harness: 'codex', profileId: s.profile.id, ownedSettings: ['model', 'model_provider', 'model_providers.pa'], original: { model: 'user-own', model_provider: null, 'model_providers.pa': null } as never, ownedValuesHash: 'old', lastWritten: codexFile.fingerprint, updatedAt: '' };
      });
      const migration = new HarnessMigration(s.fs, s.state, s.env);
      await migration.apply(await migration.plan());
      const text = await readFile(s.claude.settingsPath, 'utf8');
      expect(text).not.toContain('null');
      expect(JSON.parse(text)).toEqual({ env: { KEEP: '1', ANTHROPIC_MODEL: 'user-own' } });
      expect(await readFile(s.codex.configPath, 'utf8')).not.toContain('null');
      expect((await migration.plan()).needsMigration).toBe(false);
    } finally { await rm(s.root, { recursive: true, force: true }); }
  });

  it('refuses a stale confirmed plan', async () => {
    const s = await fixture();
    try {
      await mkdir(s.claude.dir, { recursive: true });
      await writeFile(s.claude.settingsPath, '{"apiKeyHelper":"pa-key"}');
      const migration = new HarnessMigration(s.fs, s.state, s.env);
      const plan = await migration.plan();
      await writeFile(s.claude.settingsPath, '{"apiKeyHelper":"different pa-key"}');
      await expect(migration.apply(plan)).rejects.toThrow(/changed/);
    } finally { await rm(s.root, { recursive: true, force: true }); }
  });
  it('preserves unrelated helpers and refuses replacement helper executables', async () => {
    const s = await fixture();
    try {
      await mkdir(s.claude.dir, { recursive: true });
      const custom = '{"apiKeyHelper":"/my/custom-credential-command"}';
      await writeFile(s.claude.settingsPath, custom);
      const migration = new HarnessMigration(s.fs, s.state, s.env);
      expect((await migration.plan()).needsMigration).toBe(false);
      await mkdir(join(s.data, 'bin'), { recursive: true });
      const helper = join(s.data, 'bin/pa-key');
      await writeFile(helper, 'old helper');
      const plan = await migration.plan();
      await writeFile(helper, 'replacement executable');
      await expect(migration.apply(plan)).rejects.toThrow(/changed/);
      expect(await readFile(helper, 'utf8')).toBe('replacement executable');
      expect(await readFile(s.claude.settingsPath, 'utf8')).toBe(custom);
    } finally { await rm(s.root, { recursive: true, force: true }); }
  });

  it.each(['file', 'profile'] as const)('preserves a concurrent replacement %s after plan validation', async (kind) => {
    const s = await fixture();
    try {
      await mkdir(s.claude.dir, { recursive: true });
      await writeFile(s.claude.settingsPath, '{"apiKeyHelper":"pa-key"}');
      await s.state.upsertProfile({ ...s.profile, providerId: 'pa' });
      const migration = new HarnessMigration(s.fs, s.state, s.env);
      const plan = await migration.plan();
      const snapshot = s.fs.snapshot.bind(s.fs);
      vi.spyOn(s.fs, 'snapshot').mockImplementationOnce(async (...args) => {
        if (kind === 'file') await writeFile(s.claude.settingsPath, '{"apiKeyHelper":"my-new-helper"}');
        else await s.state.upsertProfile({ ...s.profile, providerId: 'pa', label: 'User edited' });
        return snapshot(...args);
      });
      await expect(migration.apply(plan)).rejects.toThrow();
      if (kind === 'file') expect(await readFile(s.claude.settingsPath, 'utf8')).toContain('my-new-helper');
      else expect((await s.state.load()).profiles[s.profile.id]?.label).toBe('User edited');
    } finally { await rm(s.root, { recursive: true, force: true }); }
  });

  it('does not resurrect legacy originals after migration, reselect, apply and detach', async () => {
    const s = await fixture();
    try {
      await mkdir(s.codex.dir, { recursive: true });
      await writeFile(s.codex.configPath, 'model_provider="pa"\n[model_providers.pa]\nname="old"\n');
      const file = (await s.fs.readText(s.codex.configPath))!;
      await s.state.update((state) => {
        state.profiles[s.profile.id] = { ...s.profile, providerId: 'pa' };
        state.files[s.codex.configPath] = { harness: 'codex', profileId: s.profile.id, lastWritten: file.fingerprint, ownedValuesHash: 'legacy', ownedSettings: ['model_provider', 'model_providers.pa'], original: { model_provider: 'pa' }, updatedAt: new Date().toISOString() };
      });
      const migration = new HarnessMigration(s.fs, s.state, s.env);
      await migration.apply(await migration.plan());
      expect((await s.state.load()).files).toEqual({});
      await s.harness.upsertProfile({ ...s.profile, codex: { setDefault: true } });
      await s.harness.apply('codex', await s.harness.plan('codex', s.profile.id));
      await s.harness.rollback('codex', 'detach');
      expect(await readFile(s.codex.configPath, 'utf8')).not.toContain('pa');
    } finally { await rm(s.root, { recursive: true, force: true }); }
  });

});
