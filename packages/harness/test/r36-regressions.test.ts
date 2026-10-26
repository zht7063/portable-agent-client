import { describe, it, expect } from 'vitest';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ClaudeAdapter, CodexAdapter, ControlledFs, StateStore } from '@pac/harness';
import { fixture } from './v6-fixture.js';

describe('r36 ownership and restore regressions', () => {
  it('restores a pre-existing Claude token byte-exactly; all previews mask both tokens', async () => {
    const s = await fixture();
    try {
      await mkdir(s.claude.dir, { recursive: true });
      const old = 'sk-' + 'ORIGINAL'.repeat(8);
      const original = `{\r\n  "env": { "ANTHROPIC_AUTH_TOKEN" : "${old}", "KEEP": "yes" },\r\n  "theme": "dark"\r\n}\r\n`;
      await writeFile(s.claude.settingsPath, original);
      const plan = await s.harness.plan('claude', s.profile.id);
      expect(plan.warnings.join(' ')).toContain('it will be replaced');
      expect(JSON.stringify(plan)).not.toContain(old);
      await s.harness.apply('claude', plan, plan.conflicts.map((c) => ({ conflictId: c.id, resolution: 'overwrite' })));
      expect((await s.state.load()).files[s.claude.settingsPath]?.original?.['env.ANTHROPIC_AUTH_TOKEN']).toBe(old);
      expect((await stat(s.state.path)).mode & 0o777).toBe(0o600);
      expect(JSON.stringify(await s.harness.previewRollback('claude', 'detach'))).not.toContain(old);
      expect(JSON.stringify(await s.harness.history('claude'))).not.toContain(old);
      await s.harness.rollback('claude', 'detach');
      expect(await readFile(s.claude.settingsPath, 'utf8')).toBe(original);
    } finally { await rm(s.root, { recursive: true, force: true }); }
  });

  it('does not recover an unmarked swift.config.toml; marked files recover their profile id', async () => {
    const s = await fixture();
    try {
      await mkdir(s.codex.dir, { recursive: true });
      const path = join(s.codex.dir, 'swift.config.toml');
      const text = 'model="mine"\nmodel_provider="swift"\n';
      await writeFile(path, text);
      expect((await s.harness.rollback('codex', 'detach')).written).toEqual([]);
      expect(await readFile(path, 'utf8')).toBe(text);
      await writeFile(path, '# managed by swift-client provider=swift-test v=2\n' + text);
      await s.harness.rollback('codex', 'detach');
      await expect(stat(path)).rejects.toThrow();
    } finally { await rm(s.root, { recursive: true, force: true }); }
  });

  it('CLI refuses desktop projections, cannot detach them, and writes its own markers', async () => {
    const s = await fixture();
    try {
      const cliFs = new ControlledFs({ ops: s.fs.ops, roots: [s.home, s.data], dataDir: join(s.data, 'cli') });
      const options = { fs: cliFs, state: new StateStore(cliFs), env: s.env, exec: s.exec, helperPath: '', owner: 'swift-cli' as const, getKey: async () => s.keys.get(s.profile.id) };
      await options.state.upsertProfile(s.profile);
      const codex = new CodexAdapter(options); const claude = new ClaudeAdapter(options);
      await s.harness.apply('codex', await s.harness.plan('codex', s.profile.id));
      await s.harness.apply('claude', await s.harness.plan('claude', s.profile.id));
      await expect(codex.plan(s.profile)).rejects.toThrow(/other client/);
      await expect(claude.plan(s.profile)).rejects.toThrow(/other client/);
      expect((await codex.rollback('detach')).written).toEqual([]);
      expect((await claude.rollback('detach')).written).toEqual([]);
      await s.harness.rollback('codex', 'detach'); await s.harness.rollback('claude', 'detach');
      await codex.apply(await codex.plan(s.profile), { acknowledge: [] });
      await claude.apply(await claude.plan(s.profile), { acknowledge: [] });
      expect(await readFile(s.codex.configPath, 'utf8')).toContain('# managed by swift-cli provider=');
      expect(await readFile(join(s.codex.dir, 'swift-cli.config.toml'), 'utf8')).toContain('model_provider = "swift-cli"');
      expect(await readFile(s.claude.settingsPath, 'utf8')).toContain('SWIFT_CLI_MANAGED');
      await expect(s.harness.plan('codex', s.profile.id)).rejects.toThrow(/other client/);
      await expect(s.harness.plan('claude', s.profile.id)).rejects.toThrow(/other client/);
    } finally { await rm(s.root, { recursive: true, force: true }); }
  });
});
