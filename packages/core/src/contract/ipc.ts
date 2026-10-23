/**
 * Module <-> UI contract. Shared by desktop (IPC) and CLI.
 * Rule: no response or event type may contain credentials (tokens, refresh cookie, full sk keys).
 * Token list/create (full keys: main-only keys:* — store/copy/native show), login, billing and chat are served by the upstream new-api frontend via the main API proxy (M3).
 */
import type { Result } from './errors.js';
import type { SessionView } from './session.js';
import type { HarnessId, KeyringBackend, ApplyResult, HarnessApplyReq, HarnessChannelProbeReq, HarnessChannelStatus, HarnessProfile, HarnessProfileListRes, HarnessDetectRes, HarnessKeyringStatusReq, HarnessPlanReq, HarnessRollbackReq, HarnessHistory, HarnessHistoryReq, HarnessRollbackPreviewReq, KeyringStatus, Plan, RollbackPreview } from './harness.js';

// ---------- DTOs ----------
export interface ModelInfo { id: string }

/** serverUrl is null until the user configures a (standard new-api) server; there is no built-in default. */
export interface ClientConfig {
  serverUrl: string | null;
  /** Non-HTTPS server: allowed, UI warns. */ insecureTransport: boolean;
  /** Aegis N1: seconds after keys:copy before main clears the clipboard (if it still holds that key). 0 = off. */
  clipboardClearSeconds: number;
}
/** Bounds for clipboardClearSeconds (0 disables auto-clear). */
export const CLIPBOARD_CLEAR_DEFAULT = 30;
export const CLIPBOARD_CLEAR_MAX = 600;
export interface ConfigSetReq { serverUrl?: string; clipboardClearSeconds?: number }

export type Empty = Record<string, never>;

/** M4: one keychain entry (account `<profileId>/<harness>`). Metadata + masked key only, never the key. */
export interface StoredKeyInfo {
  profileId: string;
  harness: HarnessId;
  tokenId: number;
  tokenName: string;
  /** Same shape as upstream MaskTokenKey (`sk-a**********wxyz`). */
  maskedKey: string;
  storedAt: string;
  /** Entry currently present in the OS keychain. */
  present: boolean;
}
export interface KeysListRes {
  available: boolean;
  backend: KeyringBackend;
  /** Keychain unavailable (e.g. Linux without Secret Service): use env key mode; nothing is stored in plaintext. */
  fallback?: 'env';
  reason?: string;
  entries: StoredKeyInfo[];
}
export interface KeysStoreReq { tokenId: number; harness: HarnessId; /** Only 'default' in M4 (no multi-profile). */ profileId?: string }
export interface KeysCopyReq { tokenId: number }
export interface KeysCopyRes { copied: true; tokenId: number; maskedKey: string }
export interface KeysDeleteReq { harness: HarnessId; profileId?: string }
/** M5: "Show key". Main asks for confirmation in a native dialog (Cancel default) and then shows the full key in a
 *  native message box. The renderer only learns whether it was shown, plus the masked key. */
export interface KeysShowReq { tokenId: number }
export interface KeysShowRes { shown: boolean; tokenId: number; maskedKey?: string }

/** M5: server settings page. Public /api/status check result as cached in main (no credentials). */
export type ServerVerdict = 'ok' | 'untested' | 'too-old' | 'incompatible' | 'not-new-api' | 'unreachable';
export interface ServerCheckView {
  verdict: ServerVerdict;
  allowLogin: boolean;
  serverVersion: string | null;
  systemName: string | null;
  insecureTransport: boolean;
  unsupported: string[];
  turnstile: boolean;
  messages: string[];
  checkedAt: number;
}
export interface ServerStatusReq { /** Re-run the public /api/status check first. */ recheck?: boolean }
export interface ServerStatusRes {
  serverUrl: string | null;
  insecureTransport: boolean;
  compat: { tag: string; minServer: string; maxServerTested: string | null; policy: string };
  clientVersion: string;
  check: ServerCheckView | null;
}

// ---------- Invoke channels (renderer -> main, request/response) ----------
export interface IpcInvokeMap {
  'config:get': { req: Empty; res: ClientConfig };
  'config:set': { req: ConfigSetReq; res: ClientConfig };
  'harness:detect': { req: Empty; res: HarnessDetectRes };
  /** Masked diff only. */
  'harness:plan': { req: HarnessPlanReq; res: Plan };
  /** Requires confirm: true. */
  'harness:apply': { req: HarnessApplyReq; res: ApplyResult };
  /** Requires confirm: true. */
  'harness:rollback': { req: HarnessRollbackReq; res: ApplyResult };
  /** Read-only: snapshot list for the rollback UI. */
  'harness:history': { req: HarnessHistoryReq; res: HarnessHistory };
  /** Read-only dry run of a rollback; masked diff only. */
  'harness:rollback:preview': { req: HarnessRollbackPreviewReq; res: RollbackPreview };
  /** Entry presence only, never key values. */
  'harness:keyring:status': { req: HarnessKeyringStatusReq; res: KeyringStatus };
  /** Profiles are the client SSOT (no secrets: keyId only). */
  'harness:profile:list': { req: Empty; res: HarnessProfileListRes };
  'harness:profile:upsert': { req: HarnessProfile; res: HarnessProfile };
  /** Read-only server channel probe for Codex (GET /v1/models with the profile key, inside main). */
  'harness:channel:probe': { req: HarnessChannelProbeReq; res: HarnessChannelStatus };
  /** M4: keychain entries (metadata + masked key). */
  'keys:list': { req: Empty; res: KeysListRes };
  /** M4: main fetches the token's full key (main-only session) and writes it to the keychain. Returns masked info. */
  'keys:store': { req: KeysStoreReq; res: StoredKeyInfo };
  /** M4: main writes the full key to the system clipboard; the renderer only gets the masked key. */
  'keys:copy': { req: KeysCopyReq; res: KeysCopyRes };
  'keys:delete': { req: KeysDeleteReq; res: { removed: boolean } };
  /** M5: native confirm + native message box in main; never returns the key. */
  'keys:show': { req: KeysShowReq; res: KeysShowRes };
  /** M5: server URL / version / compat status for the server settings page. */
  'server:status': { req: ServerStatusReq; res: ServerStatusRes };
}
export type InvokeChannel = keyof IpcInvokeMap;
export type InvokeReq<C extends InvokeChannel> = IpcInvokeMap[C]['req'];
export type InvokeRes<C extends InvokeChannel> = Result<IpcInvokeMap[C]['res']>;

/** Channels that mutate user files and require `confirm: true` in the request. */
export const CONFIRM_REQUIRED_CHANNELS = ['harness:apply', 'harness:rollback'] as const;

/** None in M1: no channel may return credential material (the v0 `keys:show` exception was dropped). */
export const CREDENTIAL_EXCEPTION_CHANNELS = [] as const satisfies readonly InvokeChannel[];

export const INVOKE_CHANNELS = [
  'config:get', 'config:set',
  'harness:detect', 'harness:plan', 'harness:apply', 'harness:rollback', 'harness:history', 'harness:rollback:preview', 'harness:keyring:status', 'harness:profile:list', 'harness:profile:upsert', 'harness:channel:probe',
  'keys:list', 'keys:store', 'keys:copy', 'keys:delete', 'keys:show', 'server:status',
] as const satisfies readonly InvokeChannel[];

// ---------- Events (main -> renderer) ----------
export interface IpcEventMap {
  'session:changed': SessionView;
}
export type EventChannel = keyof IpcEventMap;
export const EVENT_CHANNELS = ['session:changed'] as const satisfies readonly EventChannel[];

type Call<C extends InvokeChannel> = (req: InvokeReq<C>) => Promise<InvokeRes<C>>;
type Call0<C extends InvokeChannel> = () => Promise<InvokeRes<C>>;

/**
 * Shape exposed on window.pa by the preload script (Aegis review #5): named functions, each bound to exactly one
 * channel inside the preload. There is no generic invoke(channel) / on(channel) passthrough.
 */
export interface PaBridge {
  config: { get: Call0<'config:get'>; set: Call<'config:set'> };
  harness: {
    detect: Call0<'harness:detect'>;
    plan: Call<'harness:plan'>;
    apply: Call<'harness:apply'>;
    rollback: Call<'harness:rollback'>;
    history: Call<'harness:history'>;
    rollbackPreview: Call<'harness:rollback:preview'>;
    keyringStatus: Call<'harness:keyring:status'>;
    listProfiles: Call0<'harness:profile:list'>;
    upsertProfile: Call<'harness:profile:upsert'>;
    probeChannel: Call<'harness:channel:probe'>;
  };
  /** M4: token -> keychain / clipboard. Only token ids go in; masked metadata comes out. */
  keys: { list: Call0<'keys:list'>; store: Call<'keys:store'>; copy: Call<'keys:copy'>; remove: Call<'keys:delete'>; show: Call<'keys:show'> };
  /** M5: server settings page (status only; URL changes go through config.set + native confirmation). */
  server: { status: Call<'server:status'> };
  onSessionChanged(listener: (payload: IpcEventMap['session:changed']) => void): () => void;
}

/** Bridge method -> channel (single source for the preload and its test). */
export const BRIDGE_CHANNELS = {
  'config.get': 'config:get', 'config.set': 'config:set',
  'harness.detect': 'harness:detect', 'harness.plan': 'harness:plan', 'harness.apply': 'harness:apply',
  'harness.rollback': 'harness:rollback', 'harness.history': 'harness:history', 'harness.rollbackPreview': 'harness:rollback:preview',
  'harness.keyringStatus': 'harness:keyring:status', 'harness.listProfiles': 'harness:profile:list',
  'harness.upsertProfile': 'harness:profile:upsert', 'harness.probeChannel': 'harness:channel:probe',
  'keys.list': 'keys:list', 'keys.store': 'keys:store', 'keys.copy': 'keys:copy', 'keys.remove': 'keys:delete', 'keys.show': 'keys:show',
  'server.status': 'server:status',
} as const satisfies Record<string, InvokeChannel>;
