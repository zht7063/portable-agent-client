import { redact } from './contract/redact.js';

/** Masks a value for diffs shown in UI/CLI: secret-shaped strings are hidden, others redacted and truncated. */
export function maskValue(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const raw = typeof v === 'string' ? v : JSON.stringify(v);
  if (/\bsk-[A-Za-z0-9_-]{8,}|\bnap_[A-Za-z0-9_-]{8,}|\beyJ[A-Za-z0-9_-]+\./.test(raw)) return '***';
  const s = typeof v === 'string' ? v : JSON.stringify(v, (k, value: unknown) => /token|api.?key|bearer|password|secret|helper/i.test(k) && value ? '***' : value);
  if (/\bsk-[A-Za-z0-9_-]{8,}|\bnap_[A-Za-z0-9_-]{8,}|\beyJ[A-Za-z0-9_-]+\./.test(s)) return '***';
  const r = redact(s);
  return r.length > 200 ? `${r.slice(0, 197)}...` : r;
}
