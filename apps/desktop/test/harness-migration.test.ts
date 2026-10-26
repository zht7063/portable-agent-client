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
      const original = '{"apiKeyHelper":"/old/pa-key secret-value","env":{"KEEP":"yes","OLD":"!/old/pa-key"}}';
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
      expect(await readFile(s.codex.configPath, 'utf8')).toBe('model="mine"\n');
      await expect(readFile(helper)).rejects.toThrow();
      expect((await s.state.load()).profiles).toEqual({});
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
