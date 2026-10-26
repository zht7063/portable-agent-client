/*
 * portable-agent-client local pages (AGPL-3.0-only). Copied into the new-api web build at src/pa-local/.
 *
 * Renderer-side subset of the IPC contract (packages/core/src/contract). Kept as a hand-written mirror because the
 * vendored frontend build cannot resolve workspace packages; apps/desktop/test/src-local-contract.test.ts keeps the
 * channel/method list in sync. No type here carries credential material: full keys never reach the renderer.
 */
export type HarnessId = 'pi' | 'claude' | 'codex'
export type KeyMode = 'command' | 'env' | 'plaintext'
export type PaErrorCode = string
export interface PaError { code: PaErrorCode; message: string; status?: number }
export type Result<T> = { ok: true; data: T } | { ok: false; error: PaError }

export interface ClientConfig { serverUrl: string | null; insecureTransport: boolean; clipboardClearSeconds: number }
export interface ConfigSetReq { clipboardClearSeconds?: number }

export interface ModelMapping { main: string; small?: string; opus?: string; sonnet?: string; haiku?: string; codex?: string; custom?: string }
export interface HarnessProfile {
  id: string
  label?: string
  serverUrl: string
  keyId: number
  models: ModelMapping
  keyMode: KeyMode
  providerId?: string
  envVar?: string
  pi?: Record<string, unknown>
  claude?: Record<string, unknown>
  codex?: { setDefault?: boolean } & Record<string, unknown>
}
export interface Detection { id: HarnessId; installed: boolean; version?: string | null; configDir: string; notes: string[] }
export type ChangeKind = 'create' | 'modify' | 'remove' | 'unchanged'
export interface PlannedKeyChange { file: string; setting: string; kind: ChangeKind; before: string | null; after: string | null }
export type ConflictResolution = 'overwrite' | 'keep-external' | 'cancel'
export interface Conflict { id: string; kind: string; file?: string; setting?: string; message: string }
export interface Plan {
  id: HarnessId
  changes: PlannedKeyChange[]
  conflicts: Conflict[]
  externalUnownedChange: string[]
  warnings: string[]
  [k: string]: unknown
}
export interface ApplyResult { id: HarnessId; written: string[]; snapshotId?: string; warnings: string[] }
export type RollbackTarget = 'last' | 'first-write' | 'detach' | { snapshotId: string }
export interface HarnessSnapshotInfo { snapshotId: string; at: string; action: 'apply' | 'rollback' | 'detach'; available: boolean }
export interface HarnessHistory { id: HarnessId; snapshots: HarnessSnapshotInfo[]; firstWrite: boolean; attached: boolean }
export interface RollbackPreview {
  target: RollbackTarget
  files: { path: string; kind: ChangeKind }[]
  changes: PlannedKeyChange[]
  warnings: string[]
  externalEdits?: string[]
  blocked?: string
}
export type KeyringBackend = 'macos-keychain' | 'windows-credential-manager' | 'secret-service' | 'memory' | 'none'
export interface KeyringStatus { available: boolean; backend: KeyringBackend; [k: string]: unknown }
export type HarnessChannelState = 'not-checked' | 'model-listed' | 'model-missing' | 'unreachable' | 'no-profile'
export interface HarnessChannelStatus { state: HarnessChannelState; model?: string; checkedAt: string; detail?: string }

export interface StoredKeyInfo { profileId: string; harness: HarnessId; tokenId: number; tokenName: string; maskedKey: string; storedAt: string; present: boolean }
export interface KeysListRes { available: boolean; backend: KeyringBackend; fallback?: 'env'; reason?: string; entries: StoredKeyInfo[] }
export interface KeysCopyRes { copied: true; tokenId: number; maskedKey: string }
export interface KeysShowRes { shown: boolean; tokenId: number; maskedKey?: string }

export type ServerVerdict = 'ok' | 'untested' | 'too-old' | 'incompatible' | 'not-new-api' | 'unreachable'
export interface ServerCheckView {
  verdict: ServerVerdict; allowLogin: boolean; serverVersion: string | null; systemName: string | null
  insecureTransport: boolean; unsupported: string[]; turnstile: boolean; messages: string[]; checkedAt: number
}
export interface ServerStatusRes {
  serverUrl: string | null; insecureTransport: boolean; clientVersion: string
  compat: { tag: string; minServer: string; maxServerTested: string | null; policy: string }
  check: ServerCheckView | null
}

export interface AppAboutRes {
  productName: string; version: string; license: 'AGPL-3.0-only'
  sourceUrl: string | null; sourceOffer: string | null; buildCommit: string
  upstream: { name: string; author: string; repo: string; license: string; tag: string; commit: string }
  attribution: string
  licenseFiles: { title: string; path: string }[]
}

type P<T> = Promise<Result<T>>
export interface PaBridge {
  config: { get(): P<ClientConfig>; set(r: ConfigSetReq): P<ClientConfig> }
  harness: {
    providers(): P<{ profiles: HarnessProfile[] }>
    saveProvider(r: ProviderInput): P<HarnessProfile>
    deleteProvider(r: { profileId: string; confirm: true }): P<{ removed: boolean }>
    activateProvider(r: { profileId: string }): P<HarnessProfile>
    test(r: HarnessTestReq): P<HarnessTestResult>
    models(r: { profileId: string }): P<{ models: string[] }>

    detect(): P<{ harnesses: Detection[]; registered: HarnessId[] }>
    plan(r: { id: HarnessId; profileId: string }): P<Plan>
    apply(r: { id: HarnessId; plan: Plan; acknowledge?: { conflictId: string; resolution: ConflictResolution }[]; confirm: true }): P<ApplyResult>
    rollback(r: { id: HarnessId; target: RollbackTarget; confirm: true; overwriteExternal?: boolean }): P<ApplyResult>
    history(r: { id: HarnessId }): P<HarnessHistory>
    rollbackPreview(r: { id: HarnessId; target: RollbackTarget }): P<RollbackPreview>
    keyringStatus(r: { profileId?: string }): P<KeyringStatus>
    listProfiles(): P<{ profiles: HarnessProfile[] }>
    upsertProfile(r: ProviderInput): P<HarnessProfile>
    probeChannel(r: { profileId: string }): P<HarnessChannelStatus>
  }
  keys: {
    list(): P<KeysListRes>
    store(r: { tokenId: number; harness: HarnessId; profileId?: string }): P<StoredKeyInfo>
    copy(r: { tokenId: number; curl?: { path: string; model: string } }): P<KeysCopyRes>
    remove(r: { harness: HarnessId; profileId?: string }): P<{ removed: boolean }>
    show(r: { tokenId: number }): P<KeysShowRes>
  }
  server: { status(r: { recheck?: boolean }): P<ServerStatusRes> }
  app: { about(): P<AppAboutRes> }
  onSessionChanged(l: (v: unknown) => void): () => void
}

export interface ProviderInput { id?: string; label: string; keyId: number; models: ModelMapping; codex?: { setDefault?: boolean }; claude?: { setModel?: boolean } }
export interface HarnessTestReq { profileId: string; id: HarnessId; level: 'L0' | 'L1' | 'L2' | 'L3'; confirm?: boolean; quoteId?: string; confirmUnknownCost?: boolean }
export interface HarnessTestResult { state: string; requestCount: number; model?: string; models?: string[]; quoteId?: string; tokenCap?: number; estimatedCost?: number | null; priceTableDate?: string; usageTokens?: number }
