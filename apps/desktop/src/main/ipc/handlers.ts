import { newProviderId, validateProfile } from '@pac/harness';
import type { HarnessHost } from '../harness-host';
import { SERVER_ORIGIN } from '../server-origin';
import type { ProviderInput } from '@pac/core';
import {
  CONFIRM_REQUIRED_CHANNELS,
  CREDENTIAL_EXCEPTION_CHANNELS,
  INVOKE_CHANNELS,
  err,
  findCredentialLeaks,
  ok,
  PaException,
  toPaError,
  type ClientConfig,
  type ConfigSetReq,
  type Core,
  type InvokeChannel,
  type InvokeReq,
  type InvokeRes,
  type IpcInvokeMap,
  type HarnessId,
  type KeysCopyRes,
  type KeysListRes,
  type KeysShowRes,
  type ServerStatusRes,
  type AppAboutRes,
  type StoredKeyInfo,
} from '@pac/core';
import { createModels, type Harness } from '@pac/harness';
import { maskSecret } from '../proxy/sanitize';

type Handler<C extends InvokeChannel> = (req: InvokeReq<C>) => Promise<IpcInvokeMap[C]['res']>;
export type HandlerMap = { [C in InvokeChannel]: Handler<C> };

export interface HandlerDeps {
  /** Current core (recreated when the server URL changes; throws if no server is configured). */
  getCore(): Core;
  getConfig(): ClientConfig;
  setConfig(patch: ConfigSetReq): Promise<ClientConfig>;
  harness: Harness;
  harnessHost?: HarnessHost;
  /** M4: token -> keychain / clipboard (KeyService). Absent = keys:* unavailable. */
  keys?: KeyServiceLike;
  /**
   * M5 "Show key": native main-process confirmation (Cancel default), then a native message box showing the key.
   * Both absent = refused. The key is passed main -> native dialog only; it is never returned over IPC.
   */
  confirmRevealKey?(tokenId: number): Promise<boolean>;
  showKey?(fullKey: string, tokenId: number): Promise<void>;
  /** M5: server settings page status (public /api/status check cached in main). */
  serverStatus?(recheck: boolean): Promise<ServerStatusRes>;
  /**
   * Aegis M5: turning clipboard auto-clear off (clipboardClearSeconds = 0) needs a native main-process confirmation
   * (Cancel default). Absent = refused.
   */
  confirmDisableClipboardClear?(): Promise<boolean>;
  /** M6: About & licenses data (static, non-secret). */
  about?(): AppAboutRes;
}

/** Structural view of KeyService (main-only; full keys never leave it except to keychain/clipboard/probe). */
export interface KeyServiceLike {
  fetchKey(tokenId: number): Promise<string>;
  store(tokenId: number, harness: HarnessId, profileId?: string): Promise<StoredKeyInfo>;
  list(): Promise<KeysListRes>;
  copy(tokenId: number, curl?: { path: string; model: string }): Promise<KeysCopyRes>;
  remove(harness: HarnessId, profileId?: string): Promise<{ removed: boolean }>;
}

/** Pure (no electron import) so it is unit-testable. */
export function createHandlers({ getCore, getConfig, setConfig, harness, harnessHost, keys, confirmRevealKey, showKey, serverStatus, about, confirmDisableClipboardClear }: HandlerDeps): HandlerMap {
  const k = () => { if (!keys) throw new PaException({ code: 'VALIDATION', message: 'Key storage is not available' }); return keys; };
  const profile = async (id: string) => {
    if (!/^[a-z0-9-]{1,32}$/.test(id)) throw new PaException({ code: 'VALIDATION', message: 'Invalid provider id' });
    const p = (await harness.listProfiles()).find((p) => p.id === id);
    if (!p) throw new PaException({ code: 'VALIDATION', message: 'Unknown provider' });
    return p;
  };
  async function saveProvider(r: ProviderInput) {
    strict(r, ['id', 'label', 'keyId', 'models', 'codex', 'claude']);
    strict(r.models, ['main', 'small', 'opus', 'sonnet', 'haiku', 'codex', 'custom']);
    if (r.codex) strict(r.codex, ['setDefault']);
    if (r.claude) strict(r.claude, ['setModel']);
    if (typeof r.label !== 'string' || !r.label.trim() || r.label.length > 100) throw new PaException({ code: 'VALIDATION', message: 'Invalid provider label' });
    const id = r.id ? (await profile(r.id)).id : newProviderId();
    if (!harnessHost || !keys) throw new PaException({ code: 'VALIDATION', message: 'Provider storage unavailable' });
    const p = { id, label: r.label, serverUrl: SERVER_ORIGIN, keyId: r.keyId, models: r.models, keyMode: 'plaintext' as const, providerId: 'swift', codex: r.codex, claude: r.claude };
    validateProfile(p);
    const key = await keys.fetchKey(r.keyId);
    // Validate for free before storing a credential.
    await harnessHost.connectivity.models(p, key);
    await harnessHost.keyFile.set(id, key, `token:${r.keyId}`);
    const saved = await harness.upsertProfile(p);
    await harnessHost.providers.activate(id);
    return saved;
  }
  return {
    'harness:provider:list': async () => ({ profiles: await harness.listProfiles() }),
    'harness:provider:upsert': saveProvider,
    'harness:provider:delete': async (r) => {
      const p = await profile(r.profileId);
      if (r.confirm !== true || !harnessHost) throw new PaException({ code: 'VALIDATION', message: 'Confirmation required' });
      const st = await harnessHost.state.load();
      for (const id of ['codex', 'claude'] as const) if (Object.values(st.files).some((f) => f.harness === id && f.profileId === p.id)) await harness.rollback(id, 'detach');
      await harnessHost.keyFile.delete(p.id);
      await harnessHost.state.update((s) => { delete s.profiles[p.id]; if (s.activeProvider === p.id) delete s.activeProvider; });
      await harnessHost.providers.sync();
      return { removed: true };
    },
    'harness:provider:activate': async (r) => { await profile(r.profileId); if (!harnessHost) throw new Error('Provider store unavailable'); return harnessHost.providers.activate(r.profileId); },
    'harness:models': async (r) => {
      if (!harnessHost) throw new PaException({ code: 'VALIDATION', message: 'Tests unavailable' });
      return { models: await harnessHost.connectivity.models(await profile(r.profileId)) };
    },
    'harness:test': async (r) => {
      if (!harnessHost || !['L0', 'L1', 'L2', 'L3'].includes(r.level)) throw new PaException({ code: 'VALIDATION', message: 'Invalid test' });
      return harnessHost.connectivity.test(await profile(r.profileId), r);
    },
    'config:get': async () => getConfig(),
    'config:set': async (r) => {
      strict(r, ['clipboardClearSeconds']);
      if (r && typeof r === 'object' && 'clipboardClearSeconds' in r && r.clipboardClearSeconds === 0 && getConfig().clipboardClearSeconds !== 0) {
        if (!(await confirmDisableClipboardClear?.())) {
          throw new PaException({ code: 'CANCELLED', message: 'Disabling clipboard auto-clear not confirmed; not saved' });
        }
      }
      return setConfig(r);
    },
    'harness:detect': async () => ({ harnesses: await harness.detect(), registered: harness.registered() }),
    'harness:plan': (r) => harness.plan(r.id, r.profileId),
    'harness:apply': async (r) => {
      return harness.apply(r.id, r.plan, r.acknowledge ?? []);
    },
    'harness:rollback': async (r) => {
      return harness.rollback(r.id, r.target, { overwriteExternal: r.overwriteExternal === true });
    },
    'harness:history': (r) => harness.history(r.id),
    'harness:rollback:preview': (r) => harness.previewRollback(r.id, r.target),
    'harness:keyring:status': async (r) => harnessHost ? harnessHost.keyringStatus(r?.profileId) : harness.keyringStatus(r?.profileId),
    'harness:profile:list': async () => ({ profiles: await harness.listProfiles() }),
    'harness:profile:upsert': saveProvider,
    'harness:channel:probe': async (r) => {
      const checkedAt = new Date().toISOString();
      const p = (await harness.listProfiles()).find((x) => x.id === r?.profileId);
      if (!p) return { state: 'no-profile' as const, checkedAt };
      const model = p.models.codex ?? p.models.main;
      const origin = (u: string) => { try { return new URL(u).origin; } catch { return ''; } };
      if (origin(p.serverUrl) !== origin(getConfig().serverUrl ?? '')) return { state: 'unreachable' as const, model, checkedAt, detail: 'Profile server differs from the configured server' };
      const core = getCore();
      let ids: string[];
      try {
        const sk = keys ? await keys.fetchKey(p.keyId) : await core.keys.secret(p.keyId);
        ids = (await createModels(core.http).listWithKey(sk)).map((m) => m.id);
      } catch {
        return { state: 'unreachable' as const, model, checkedAt, detail: 'GET /v1/models failed' };
      }
      return { state: ids.includes(model) ? ('model-listed' as const) : ('model-missing' as const), model, checkedAt };
    },
    'keys:list': async () => k().list(),
    'keys:store': async (r) => k().store(r?.tokenId, r?.harness, r?.profileId),
    'keys:copy': async (r) => k().copy(r?.tokenId, r?.curl),
    'keys:delete': async (r) => k().remove(r?.harness, r?.profileId),
    'keys:show': async (r): Promise<KeysShowRes> => {
      const tokenId = r?.tokenId;
      if (typeof tokenId !== 'number' || !Number.isSafeInteger(tokenId) || tokenId <= 0) throw new PaException({ code: 'VALIDATION', message: 'Invalid token id' });
      const svc = k();
      if (!confirmRevealKey || !showKey) throw new PaException({ code: 'VALIDATION', message: 'Showing keys is not available' });
      if (!(await confirmRevealKey(tokenId))) return { shown: false, tokenId };
      const key = await svc.fetchKey(tokenId);
      await showKey(key, tokenId);
      return { shown: true, tokenId, maskedKey: maskSecret(key) };
    },
    'server:status': async (r) => {
      if (!serverStatus) throw new PaException({ code: 'VALIDATION', message: 'Server status is not available' });
      return serverStatus(r?.recheck === true);
    },
    'app:about': async () => {
      if (!about) throw new PaException({ code: 'VALIDATION', message: 'About is not available' });
      return about();
    },
  };
}

const exempt = new Set<string>(CREDENTIAL_EXCEPTION_CHANNELS);

/** Wraps a handler: validates channel, converts errors to Result, guards against credential leaks. */
export async function dispatch<C extends InvokeChannel>(handlers: HandlerMap, channel: C, req: InvokeReq<C>): Promise<InvokeRes<C>> {
  if (!(INVOKE_CHANNELS as readonly string[]).includes(channel)) return err('VALIDATION', 'Unknown channel');
  if ((CONFIRM_REQUIRED_CHANNELS as readonly string[]).includes(channel) && (req as { confirm?: unknown })?.confirm !== true) {
    return err('VALIDATION', 'This action requires explicit confirmation');
  }
  try {
    strict(req ?? {}, IPC_FIELDS[channel]);
    const addressFields = (value: unknown): boolean => value !== null && typeof value === 'object' && Object.entries(value).some(([name, child]) => /^(serverUrl|host|origin|providerId)$/i.test(name) || addressFields(child));
    if (addressFields(req)) return err('VALIDATION', 'Address fields are not accepted');
    const data = await (handlers[channel] as Handler<C>)(req);
    if (!exempt.has(channel) && findCredentialLeaks(data).length) return err('SERVER', 'Blocked: response contained credential material');
    return ok(data);
  } catch (e) {
    return { ok: false, error: toPaError(e) };
  }
}


export const IPC_FIELDS: Record<InvokeChannel, string[]> = {
  'config:get': [], 'config:set': ['clipboardClearSeconds'],
  'harness:detect': [], 'harness:plan': ['id', 'profileId'],
  'harness:apply': ['id', 'plan', 'acknowledge', 'confirm'],
  'harness:rollback': ['id', 'target', 'confirm', 'overwriteExternal'],
  'harness:history': ['id'], 'harness:rollback:preview': ['id', 'target'],
  'harness:keyring:status': ['profileId'], 'harness:profile:list': [],
  'harness:profile:upsert': ['id', 'label', 'keyId', 'models', 'codex', 'claude'],
  'harness:provider:list': [], 'harness:provider:upsert': ['id', 'label', 'keyId', 'models', 'codex', 'claude'],
  'harness:provider:delete': ['profileId', 'confirm'], 'harness:provider:activate': ['profileId'],
  'harness:test': ['profileId', 'id', 'level', 'confirm', 'quoteId', 'confirmUnknownCost'], 'harness:models': ['profileId'],
  'harness:channel:probe': ['profileId'],
  'keys:list': [], 'keys:store': ['tokenId', 'harness', 'profileId'], 'keys:copy': ['tokenId', 'curl'], 'keys:delete': ['harness', 'profileId'], 'keys:show': ['tokenId'],
  'server:status': ['recheck'], 'app:about': [],
};
function strict(value: unknown, allowed: string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((k) => !allowed.includes(k))) throw new PaException({ code: 'VALIDATION', message: 'Unexpected request field' });
}
