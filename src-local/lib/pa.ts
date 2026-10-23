/*
 * portable-agent-client local pages (AGPL-3.0-only).
 * Access to the narrow preload bridge (window.pa). Results are unwrapped into exceptions with a readable message.
 */
import type { PaBridge, Result } from './pa-types'

declare global {
  interface Window { pa?: PaBridge }
}

export class PaCallError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'PaCallError' }
}

/** True inside the desktop client (preload bridge present). The plain web build keeps upstream behaviour. */
export const isPaDesktop = (): boolean => typeof window !== 'undefined' && !!window.pa

export function pa(): PaBridge {
  if (!window.pa) throw new PaCallError('UNAVAILABLE', 'Desktop bridge unavailable')
  return window.pa
}

export async function unwrap<T>(p: Promise<Result<T>>): Promise<T> {
  const r = await p
  if (!r || typeof r !== 'object') throw new PaCallError('SERVER', 'Invalid response')
  if (r.ok) return r.data
  throw new PaCallError(r.error?.code ?? 'SERVER', r.error?.message ?? 'Request failed')
}

export const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export const fileName = (f: string) => f.split(/[\\/]/).pop() ?? f

export const HARNESS_IDS = ['pi', 'claude', 'codex'] as const
export const HARNESS_TITLE: Record<(typeof HARNESS_IDS)[number], string> = { pi: 'Pi', claude: 'Claude Code', codex: 'Codex' }
