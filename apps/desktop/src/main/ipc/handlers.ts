import {
  CONFIRM_REQUIRED_CHANNELS,
  CREDENTIAL_EXCEPTION_CHANNELS,
  INVOKE_CHANNELS,
  err,
  findCredentialLeaks,
  ok,
  PaException,
  normalizeServerUrl,
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
  /**
   * Aegis #3: native (main-process) confirmation when a harness profile points at a server other than the client's
   * own. Absent = refuse. Never driven by the renderer.
   */
  confirmForeignServer?(profileOrigin: string, clientOrigin: string): Promise<boolean>;
  /**
   * Aegis (M3 review #1): the server URL decides where the main-only session, passwords and keys go, so a renderer
   * request to change it needs a native main-process confirmation (full URL shown, Cancel default). Absent = refuse.
   */
  confirmServerChange?(nextUrl: string, currentUrl: string | null): Promise<boolean>;
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
export function createHandlers({ getCore, getConfig, setConfig, harness, confirmForeignServer, confirmServerChange, keys, confirmRevealKey, showKey, serverStatus }: HandlerDeps): HandlerMap {
  const k = () => { if (!keys) throw new PaException({ code: 'VALIDATION', message: 'Key storage is not available' }); return keys; };
  return {
    'config:get': async () => getConfig(),
    'config:set': async (r) => {
      if (r && typeof r === 'object' && 'serverUrl' in r) {
        const next = r.serverUrl;
        let nextUrl: string;
        // Aegis N3: full validation (http/https only, no userinfo `user:pass@`, no query/fragment) BEFORE any dialog,
        // so a credential-bearing or deceptive URL is never even offered for confirmation.
        try { nextUrl = new URL(normalizeServerUrl(String(next))).href; }
        catch (e) { throw e instanceof PaException ? e : new PaException({ code: 'VALIDATION', message: 'Invalid server URL' }); }
        const cur = getConfig().serverUrl;
        const same = (() => { try { return !!cur && new URL(cur).href === nextUrl; } catch { return false; } })();
        if (!same && !(await confirmServerChange?.(nextUrl, cur))) {
          throw new PaException({ code: 'CANCELLED', message: 'Server change not confirmed; not saved' });
        }
      }
      return setConfig(r);
    },
    'harness:detect': async () => ({ harnesses: await harness.detect(), registered: harness.registered() }),
    'harness:plan': (r) => harness.plan(r.id, r.profileId),
    'harness:apply': async (r) => {
      // Aegis: compare against the client's *current* server at apply time (the user may have switched servers since
      // the profile was saved/confirmed). Foreign origin -> native confirmation (Cancel default); no dialog -> refuse.
      const origin = (u: unknown) => { try { return typeof u === 'string' ? new URL(u).origin : ''; } catch { return ''; } };
      const p = (await harness.listProfiles()).find((x) => x.id === r?.plan?.profileId);
      if (p) {
        const want = origin(p.serverUrl); const client = origin(getConfig().serverUrl ?? '');
        if (want !== client && !(await confirmForeignServer?.(want, client))) {
          throw new PaException({ code: 'CANCELLED', message: 'Profile server differs from the client server; not applied' });
        }
      }
      return harness.apply(r.id, r.plan, r.acknowledge ?? []);
    },
    'harness:rollback': (r) => harness.rollback(r.id, r.target, { overwriteExternal: r.overwriteExternal === true }),
    'harness:history': (r) => harness.history(r.id),
    'harness:rollback:preview': (r) => harness.previewRollback(r.id, r.target),
    'harness:keyring:status': (r) => harness.keyringStatus(r?.profileId),
    'harness:profile:list': async () => ({ profiles: await harness.listProfiles() }),
    'harness:profile:upsert': async (r) => {
      const origin = (u: unknown) => { try { return typeof u === 'string' ? new URL(u).origin : ''; } catch { return ''; } };
      const want = origin(r?.serverUrl); const client = origin(getConfig().serverUrl ?? '');
      if (want && want !== client) {
        // Already-confirmed foreign origin for this profile does not prompt again.
        const prev = (await harness.listProfiles()).find((x) => x.id === r.id);
        if (origin(prev?.serverUrl) !== want && !(await confirmForeignServer?.(want, client))) {
          throw new PaException({ code: 'CANCELLED', message: 'Profile server differs from the client server; not saved' });
        }
      }
      return harness.upsertProfile(r);
    },
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
    const data = await (handlers[channel] as Handler<C>)(req);
    if (!exempt.has(channel) && findCredentialLeaks(data).length) return err('SERVER', 'Blocked: response contained credential material');
    return ok(data);
  } catch (e) {
    return { ok: false, error: toPaError(e) };
  }
}

