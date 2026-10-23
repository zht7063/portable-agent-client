import { PaException } from './contract/errors.js';

/** Validates and normalizes a server base URL (http/https origin + optional path, no query/hash/credentials). */
export function normalizeServerUrl(input: string): string {
  const raw = (input ?? '').trim();
  let u: URL;
  try { u = new URL(raw); } catch { throw new PaException({ code: 'VALIDATION', message: 'Invalid server URL' }); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new PaException({ code: 'VALIDATION', message: 'Server URL must use http:// or https://' });
  if (u.username || u.password) throw new PaException({ code: 'VALIDATION', message: 'Server URL must not contain credentials' });
  if (u.search || u.hash) throw new PaException({ code: 'VALIDATION', message: 'Server URL must not contain query or fragment' });
  if (!u.hostname) throw new PaException({ code: 'VALIDATION', message: 'Server URL must include a host' });
  return (u.origin + u.pathname).replace(/\/+$/, '');
}

/** Non-HTTPS servers are allowed (warn only, product decision); the UI shows a warning when this is true. */
export const isInsecureServerUrl = (url: string): boolean => !url.startsWith('https://');
