import { err, type Result } from '@pac/core/contract';

/** Minimal structural views of Electron objects so this stays unit-testable without electron. */
export interface FrameLike { url: string; parent: FrameLike | null }
export interface SenderEventLike { sender: unknown; senderFrame: FrameLike | null }
export interface WindowLike { isDestroyed?(): boolean; webContents: { mainFrame: FrameLike } }

const stripUrl = (u: string) => { try { const x = new URL(u); x.hash = ''; x.search = ''; return x.href; } catch { return null; } };

/**
 * Accept IPC only from the top-level frame of our own BrowserWindow, showing our bundled renderer.
 * `allowed` is an exact URL (hash/query ignored) or a predicate (M2: any path on our app:// origin, SPA routes).
 * Rejects: other webContents, sub-frames/iframes, destroyed or not-yet-created windows, any other URL.
 */
export function isTrustedSender(e: SenderEventLike, win: WindowLike | null | undefined, allowed: string | ((url: string) => boolean)): boolean {
  if (!win || win.isDestroyed?.()) return false;
  const frame = e.senderFrame;
  if (!frame) return false; // frame navigated away or was destroyed
  if (e.sender !== win.webContents) return false;
  if (frame !== win.webContents.mainFrame || frame.parent !== null) return false;
  if (typeof allowed === 'function') return allowed(frame.url);
  const want = stripUrl(allowed);
  return want !== null && stripUrl(frame.url) === want;
}

export const untrustedSender = (): Result<never> => err('UNAUTHORIZED', 'Untrusted IPC sender');
