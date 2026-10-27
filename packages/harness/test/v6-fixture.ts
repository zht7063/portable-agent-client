import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAdapter, CodexAdapter, ControlledFs, createHarness, nodeFsOps, StateStore, KeyFile, type ExecFn } from '@pac/harness';
import type { HarnessProfile } from '@pac/core';
import committedOrigin from '../../../apps/desktop/build/server-origin.json' with { type: 'json' };
export const CANARY = 'sk-LEAKCANARY-' + 'Z'.repeat(32);
export async function fixture(origin = committedOrigin.origin) {
  const root = await mkdtemp(join(tmpdir(), 'swift-v6-'));
  const home = join(root, 'home'); const data = join(root, 'data');
  await mkdir(home); await mkdir(data);
  const fs = new ControlledFs({ ops: nodeFsOps, roots: [home, data], dataDir: data });
  const state = new StateStore(fs); const keys = new KeyFile(data);
  await keys.set('swift-test', CANARY, 'token:7');
  const exec: ExecFn = async () => ({ code: 0, stdout: '0.164.0', stderr: '' });
  const env = { home, platform: 'linux' as const, env: { HOME: home, CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude') } };
  const options = { fs, state, exec, env, helperPath: '', getKey: async () => keys.get('swift-test') };
  const codex = new CodexAdapter(options); const claude = new ClaudeAdapter(options);
  const harness = createHarness({ fs, state, exec, env, adapters: { codex, claude } });
  const profile: HarnessProfile = { id: 'swift-test', serverUrl: origin, keyId: 7, keyMode: 'plaintext', models: { main: 'test-main', small: 'test-small', codex: 'test-codex', custom: 'test-custom' } };
  await harness.upsertProfile(profile);
  return { root, home, data, fs, state, keys, env, exec, codex, claude, harness, profile };
}
