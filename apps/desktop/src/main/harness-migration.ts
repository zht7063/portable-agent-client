/** beta.1 self-check. Plans contain paths/reasons only; credentials never leave main. */
import type { FileFingerprint } from '@pac/core';
import { join } from 'node:path';
import { configDir, mergeOwnedJson, mergeOwnedToml, parseToml, canonicalJson, sha256Hex, type ControlledFs, type HarnessEnv, type StateStore } from '@pac/harness';

export class HarnessMigration {
  constructor(private readonly fs: ControlledFs, private readonly state: StateStore, private readonly env: HarnessEnv) {}

  private async changes() {
    const changes: { path: string; after: string; fingerprint: FileFingerprint; harness: 'claude' | 'codex' }[] = [];
    const claude = join(configDir('claude', this.env), 'settings.json');
    const c = await this.fs.readText(claude);
    if (c) {
      const root = JSON.parse(c.text) as { apiKeyHelper?: unknown; env?: Record<string, unknown> };
      const edits: { path: string[]; value: unknown }[] = [];
      if (typeof root.apiKeyHelper === 'string' && (/pa-key/i.test(root.apiKeyHelper) || root.apiKeyHelper === `printf '%s' "$PA_API_KEY"`)) {
        edits.push({ path: ['apiKeyHelper'], value: undefined });
        for (const key of Object.keys(root.env ?? {})) if (key === 'ANTHROPIC_BASE_URL' || /^ANTHROPIC_.*MODEL/.test(key)) edits.push({ path: ['env', key], value: undefined });
      }
      for (const [key, value] of Object.entries(root.env ?? {})) if (typeof value === 'string' && /pa-key/i.test(value)) edits.push({ path: ['env', key], value: undefined });
      if (edits.length) changes.push({ path: claude, after: mergeOwnedJson(c.text, edits), fingerprint: c.fingerprint, harness: 'claude' });
    }
    const codex = join(configDir('codex', this.env), 'config.toml');
    const cdx = await this.fs.readText(codex);
    if (cdx) {
      const root = parseToml(cdx.text);
      const edits: { path: string[]; value: unknown }[] = [];
      if ((root.model_providers as Record<string, unknown> | undefined)?.pa !== undefined) edits.push({ path: ['model_providers', 'pa'], value: undefined });
      if (root.model_provider === 'pa') edits.push({ path: ['model_provider'], value: undefined }, { path: ['model'], value: undefined });
      if (edits.length) changes.push({ path: codex, after: mergeOwnedToml(cdx.text, edits), fingerprint: cdx.fingerprint, harness: 'codex' });
    }
    const helperPaths = ['pa-key', 'pa-key.cmd'].map((name) => join(this.fs.dataDir, 'bin', name));
    const helpers: { path: string; fingerprint: FileFingerprint }[] = [];
    for (const path of helperPaths) { const file = await this.fs.readText(path); if (file) helpers.push({ path, fingerprint: file.fingerprint }); }
    const state = await this.state.load();
    const profiles = Object.values(state.profiles).filter((p) => p.providerId === 'pa' || p.keyMode === 'command');
    const legacyIds = new Set(profiles.map((p) => p.id));
    const paths = new Set(changes.map((c) => c.path));
    const ownership = Object.entries(state.files).filter(([path, entry]) =>
      (entry.profileId && legacyIds.has(entry.profileId)) || (paths.has(path) && (
        entry.ownedSettings.some((s) => s === 'apiKeyHelper' || s.startsWith('model_providers.pa')) ||
        Object.entries(entry.original ?? {}).some(([key, value]) => typeof value === 'string' && (/pa-key/i.test(value) || (key === 'model_provider' && value === 'pa')))
      )));
    // Restore beta-owned settings before dropping their ownership records.
    for (const [path, entry] of ownership) {
      const file = await this.fs.readText(path);
      if (!file) continue;
      const edits = entry.ownedSettings.map((key) => {
        let value = entry.original?.[key];
        if ((key === 'apiKeyHelper' && typeof value === 'string' && (/pa-key/i.test(value) || value === `printf '%s' "$PA_API_KEY"`)) || (key === 'model_provider' && value === 'pa') || key.startsWith('model_providers.pa')) value = undefined;
        return { path: key.split('.'), value };
      });
      const existing = changes.find((c) => c.path === path);
      const merge = entry.harness === 'codex' ? mergeOwnedToml : mergeOwnedJson;
      const after = merge(existing?.after ?? file.text, edits);
      if (existing) existing.after = after;
      else if (after !== file.text && (entry.harness === 'claude' || entry.harness === 'codex')) changes.push({ path, after, fingerprint: file.fingerprint, harness: entry.harness });
    }
    return { changes, helpers, profiles, ownership };
  }

  private summary({ changes, helpers, profiles, ownership }: Awaited<ReturnType<HarnessMigration['changes']>>) {
    return {
      files: changes.map((c) => c.path),
      fingerprints: changes.map((c) => c.fingerprint),
      helpers: helpers.map((h) => h.path),
      helperFingerprints: helpers.map((h) => h.fingerprint),
      profiles: profiles.map((p) => p.id),
      profileHashes: profiles.map((p) => sha256Hex(canonicalJson(p))),
      ownership: ownership.map(([path, entry]) => ({ path, hash: sha256Hex(canonicalJson(entry)) })),
      needsMigration: !!(changes.length || helpers.length || profiles.length || ownership.length),
    };
  }

  async plan() { return this.summary(await this.changes()); }

  /** Execute exactly the operations validated against the confirmed plan. */
  async apply(plan: Awaited<ReturnType<HarnessMigration['plan']>>) {
    const operations = await this.changes();
    if (JSON.stringify(plan) !== JSON.stringify(this.summary(operations))) throw new Error('Migration plan changed; review again');
    const { changes, helpers, profiles, ownership } = operations;
    for (const change of changes) {
      await this.fs.snapshot(change.harness, [change.path]);
      await this.fs.atomicWrite(change.path, change.after, { expect: change.fingerprint });
    }
    for (const helper of helpers) await this.fs.remove(helper.path, { expect: helper.fingerprint });
    if (profiles.length || ownership.length) await this.state.update((s) => {
      for (const [path, entry] of ownership) if (canonicalJson(s.files[path]) !== canonicalJson(entry)) throw new Error('Migration ownership changed; review again');
      for (const profile of profiles) {
        if (canonicalJson(s.profiles[profile.id]) !== canonicalJson(profile)) throw new Error('Migration profile changed; review again');
      }
      for (const [path] of ownership) delete s.files[path];
      for (const profile of profiles) {
        delete s.profiles[profile.id];
        if (s.activeProvider === profile.id) delete s.activeProvider;
      }
    });
  }
}
