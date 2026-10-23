/**
 * Module <-> UI contract. Shared by desktop (IPC) and CLI.
 * Rule: no response or event type may contain credentials (tokens, refresh cookie, full sk keys).
 * Token list/create/reveal, login, billing and chat are served by the upstream new-api frontend via the main API proxy (M3).
 */
import type { Result } from './errors.js';
import type { SessionView } from './session.js';
import type { ApplyResult, HarnessApplyReq, HarnessChannelProbeReq, HarnessChannelStatus, HarnessProfile, HarnessProfileListRes, HarnessDetectRes, HarnessKeyringStatusReq, HarnessPlanReq, HarnessRollbackReq, HarnessHistory, HarnessHistoryReq, HarnessRollbackPreviewReq, KeyringStatus, Plan, RollbackPreview } from './harness.js';

// ---------- DTOs ----------
export interface ModelInfo { id: string }

/** serverUrl is null until the user configures a (standard new-api) server; there is no built-in default. */
export interface ClientConfig { serverUrl: string | null; /** Non-HTTPS server: allowed, UI warns. */ insecureTransport: boolean }
export interface ConfigSetReq { serverUrl?: string }

export type Empty = Record<string, never>;

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
}
export type InvokeChannel = keyof IpcInvokeMap;
export type InvokeReq<C extends InvokeChannel> = IpcInvokeMap[C]['req'];
export type InvokeRes<C extends InvokeChannel> = Result<IpcInvokeMap[C]['res']>;

/** Channels that mutate user files and require `confirm: true` in the request. */
export const CONFIRM_REQUIRED_CHANNELS = ['harness:apply', 'harness:rollback'] as const;

/** None in M1: no channel may return credential material (the v0 `keys:reveal` exception was dropped). */
export const CREDENTIAL_EXCEPTION_CHANNELS = [] as const satisfies readonly InvokeChannel[];

export const INVOKE_CHANNELS = [
  'config:get', 'config:set',
  'harness:detect', 'harness:plan', 'harness:apply', 'harness:rollback', 'harness:history', 'harness:rollback:preview', 'harness:keyring:status', 'harness:profile:list', 'harness:profile:upsert', 'harness:channel:probe',
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
  onSessionChanged(listener: (payload: IpcEventMap['session:changed']) => void): () => void;
}

/** Bridge method -> channel (single source for the preload and its test). */
export const BRIDGE_CHANNELS = {
  'config.get': 'config:get', 'config.set': 'config:set',
  'harness.detect': 'harness:detect', 'harness.plan': 'harness:plan', 'harness.apply': 'harness:apply',
  'harness.rollback': 'harness:rollback', 'harness.history': 'harness:history', 'harness.rollbackPreview': 'harness:rollback:preview',
  'harness.keyringStatus': 'harness:keyring:status', 'harness.listProfiles': 'harness:profile:list',
  'harness.upsertProfile': 'harness:profile:upsert', 'harness.probeChannel': 'harness:channel:probe',
} as const satisfies Record<string, InvokeChannel>;
