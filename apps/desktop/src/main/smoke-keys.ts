import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Keyring } from '@pac/keychain';

/*
 * Dev-only M4 smoke step (PA_SMOKE_LOGIN=1 PA_SMOKE_KEYS=1, LOCAL test server, throwaway account, temp HOME).
 * After the login smoke: from the renderer, keys:store (token -> keychain) / keys:list / keys:copy, then save a
 * command-mode harness profile and apply Claude. Main then checks keychain, clipboard, pa-key and the written config
 * by comparison only (the key is never printed). Every IPC response is returned to the leak audit.
 */
export interface KeysSmokeDeps {
  tokenId: number;
  serverUrl: string;
  keyring: Keyring;
  helperPath: string;
  home: string;
  readClipboard(): string;
  clearClipboard(): void;
}

export async function runKeysSmokeStep(js: <T>(code: string) => Promise<T>, rawKey: string, d: KeysSmokeDeps) {
  const secret = rawKey.startsWith('sk-') ? rawKey : `sk-${rawKey}`; // what the relay / harness uses
  const ipc = await js<Record<string, unknown>>(`(async () => {
    const pa = window.pa;
    const store = await pa.keys.store({ tokenId: ${d.tokenId}, harness: 'claude' });
    const list = await pa.keys.list();
    const copy = await pa.keys.copy({ tokenId: ${d.tokenId} });
    const profile = await pa.harness.upsertProfile({ id: 'default', serverUrl: ${JSON.stringify(d.serverUrl)}, keyId: ${d.tokenId}, models: { main: 'smoke-model' }, keyMode: 'command' });
    const plan = await pa.harness.plan({ id: 'claude', profileId: 'default' });
    const apply = plan.ok ? await pa.harness.apply({ id: 'claude', plan: plan.data, confirm: true }) : null;
    const status = await pa.harness.keyringStatus({});
    return { store, list, copy, profile, plan, apply, status };
  })()`);
  const keychainMatches = (await d.keyring.get('default/claude')) === secret;
  const clipboardMatches = d.readClipboard() === secret;
  d.clearClipboard();
  let paKeyMatches = false;
  try { paKeyMatches = execFileSync(d.helperPath, ['default', 'claude'], { encoding: 'utf8', env: process.env }) === secret; } catch { paKeyMatches = false; }
  let settings = '';
  try { settings = readFileSync(join(d.home, '.claude', 'settings.json'), 'utf8'); } catch { /* not written */ }
  const r = ipc as Record<string, { ok?: boolean; data?: Record<string, unknown> }>;
  const result = {
    storeOk: r.store?.ok === true, stored: r.store?.ok ? { tokenId: r.store.data?.tokenId, harness: r.store.data?.harness, maskedKey: r.store.data?.maskedKey, present: r.store.data?.present } : r.store,
    listEntries: (r.list?.data?.entries as unknown[] | undefined)?.length ?? 0, keychainBackend: r.list?.data?.backend,
    copyOk: r.copy?.ok === true, applyOk: r.apply?.ok === true, planOk: r.plan?.ok === true,
    keychainMatches, clipboardMatches, paKeyMatches,
    claudeConfigUsesHelper: settings.includes('apiKeyHelper') && settings.includes(d.helperPath), claudeConfigHasKey: settings.includes(secret),
  };
  const ok = result.storeOk && result.copyOk && result.applyOk && keychainMatches && clipboardMatches && paKeyMatches && result.claudeConfigUsesHelper && !result.claudeConfigHasKey;
  return { result, ok, haystack: JSON.stringify(ipc) };
}
