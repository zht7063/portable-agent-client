/*
 * M7: window / session hardening in one testable place (used by index.ts; covered by test/security/guards.test.ts).
 * Every renderer permission is denied, downloads are cancelled, webviews cannot attach and new windows never open.
 */

/** BrowserWindow webPreferences for the app window (preload path is added by the caller). */
export const SECURE_WEB_PREFERENCES = Object.freeze({
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  spellcheck: false,
  navigateOnDragDrop: false,
} as const);

export interface SessionLike {
  setPermissionRequestHandler(h: (wc: unknown, permission: string, cb: (granted: boolean) => void, details?: unknown) => void): void;
  setPermissionCheckHandler(h: (...a: unknown[]) => boolean): void;
  setDevicePermissionHandler(h: (...a: unknown[]) => boolean): void;
  on(ev: 'will-download', l: (e: { preventDefault(): void }, ...a: unknown[]) => void): unknown;
}

export interface WebContentsLike {
  on(ev: 'will-attach-webview', l: (e: { preventDefault(): void }, ...a: unknown[]) => void): unknown;
  setWindowOpenHandler(h: (d: { url: string }) => { action: 'deny' }): void;
}

/** Deny all permission requests/checks (camera, mic, notifications, clipboard-read, HID/USB/serial, ...); cancel downloads. */
export function applySessionPolicy(ses: SessionLike): void {
  ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.on('will-download', (e) => e.preventDefault());
}

/** Applied to every webContents (incl. any unexpected one): no <webview>, no new windows. */
export function hardenWebContents(wc: WebContentsLike, onOpen?: (url: string) => void): void {
  wc.on('will-attach-webview', (e) => e.preventDefault());
  wc.setWindowOpenHandler(({ url }) => { onOpen?.(url); return { action: 'deny' }; });
}
