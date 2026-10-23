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

/** Shape exposed on window.pa by the preload script. */
export interface PaBridge {
  invoke<C extends InvokeChannel>(channel: C, req: InvokeReq<C>): Promise<InvokeRes<C>>;
  on<E extends EventChannel>(channel: E, listener: (payload: IpcEventMap[E]) => void): () => void;
}
