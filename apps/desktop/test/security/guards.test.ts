/* M7: CSP, navigation and permission guards (pure policy functions used by main/index.ts). */
import { describe, expect, it, vi } from 'vitest';
import { buildCsp, handleAppRequest, navigationDecision, securityHeaders } from '../../src/main/app-protocol';
import { applySessionPolicy, hardenWebContents, SECURE_WEB_PREFERENCES } from '../../src/main/security-policy';
import { isTrustedSender } from '../../src/main/ipc/sender';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const S = 'pac';
const memFs = { readFile: async () => new TextEncoder().encode('<html></html>'), isFile: async () => true };

describe('CSP', () => {
  it('is exactly the reviewed policy (any change must update this test + docs/security-tests.md)', () => {
    expect(buildCsp(S).split('; ')).toEqual([
      "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "font-src 'self'",
      'connect-src \'self\' pac:', "frame-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
    ]);
  });
  it('never allows eval, inline script, remote origins or wildcards', () => {
    const csp = buildCsp(S);
    for (const bad of ["'unsafe-eval'", "'wasm-unsafe-eval'", 'http:', 'https:', ' * ', 'ws:', 'data: ;', "script-src 'self' 'unsafe-inline'"]) expect(csp).not.toContain(bad);
    expect(csp).not.toMatch(/script-src[^;]*(data:|blob:|'unsafe-inline')/);
  });
  it('every app-protocol response (file, SPA, rejects, proxied, stub) carries CSP + hardening headers', async () => {
    const urls = ['pac://app/', 'pac://app/keys', 'pac://app/x.js', 'pac://app/%2e%2e/etc/passwd', 'pac://evil/x', 'pac://app/api/status'];
    const server = async () => new Response('{}', { headers: { 'content-security-policy': "default-src *", 'set-cookie': 'a=b' } });
    for (const u of urls) {
      for (const srv of [undefined, server]) {
        const r = await handleAppRequest({ url: u, method: 'GET' }, '/root', S, memFs, srv);
        for (const [k, v] of Object.entries(securityHeaders(S))) expect(r.headers.get(k), `${u} ${k}`).toBe(v);
        expect(r.headers.get('set-cookie')).toBeNull();
      }
    }
  });
});

describe('navigation / window.open', () => {
  it.each([
    ['pac://app/keys', 'navigate', 'allow'], ['pac://app/keys', 'open', 'deny'],
    ['https://example.com/docs', 'navigate', 'external'], ['https://example.com/docs', 'open', 'external'],
    ['http://example.com/', 'navigate', 'deny'], ['https://user:pw@example.com/', 'open', 'deny'],
    ['file:///etc/passwd', 'navigate', 'deny'], ['javascript:alert(1)', 'open', 'deny'], ['data:text/html,<b>x</b>', 'navigate', 'deny'],
    ['pac://evil/', 'navigate', 'deny'], ['chrome://settings', 'navigate', 'deny'], ['ccswitch://x?key=sk-abc', 'open', 'deny'],
    ['about:blank', 'open', 'deny'], ['blob:pac://app/123', 'navigate', 'deny'], ['not a url', 'navigate', 'deny'],
  ] as const)('%s (%s) -> %s', (url, kind, action) => {
    expect(navigationDecision(url, S, kind).action).toBe(action);
  });
});

describe('permissions / downloads / webviews / windows', () => {
  it('session policy denies every permission and cancels downloads', () => {
    const h: Record<string, (...a: unknown[]) => unknown> = {};
    applySessionPolicy({
      setPermissionRequestHandler: (f) => { h.req = f as never; }, setPermissionCheckHandler: (f) => { h.check = f; },
      setDevicePermissionHandler: (f) => { h.device = f; }, on: (_ev, l) => { h.dl = l as never; },
    });
    for (const p of ['media', 'geolocation', 'notifications', 'clipboard-read', 'clipboard-sanitized-write', 'hid', 'usb', 'serial', 'openExternal', 'fullscreen', 'pointerLock']) {
      const cb = vi.fn(); h.req!({}, p, cb); expect(cb).toHaveBeenCalledWith(false);
      expect(h.check!({}, p, 'pac://app')).toBe(false);
    }
    expect(h.device!({ deviceType: 'usb' })).toBe(false);
    const ev = { preventDefault: vi.fn() }; h.dl!(ev); expect(ev.preventDefault).toHaveBeenCalled();
  });
  it('every webContents: webview attach prevented, window.open denied (callback only observes the url)', () => {
    let attach: (e: { preventDefault(): void }) => void = () => {}; let open: (d: { url: string }) => unknown = () => null; const seen: string[] = [];
    hardenWebContents({ on: (_e, l) => { attach = l as never; }, setWindowOpenHandler: (f) => { open = f; } }, (u) => seen.push(u));
    const ev = { preventDefault: vi.fn() }; attach(ev); expect(ev.preventDefault).toHaveBeenCalled();
    expect(open({ url: 'https://x.test' })).toEqual({ action: 'deny' });
    expect(open({ url: 'pac://app/' })).toEqual({ action: 'deny' });
    expect(seen).toEqual(['https://x.test', 'pac://app/']);
  });
  it('window webPreferences are locked down', () => {
    expect(SECURE_WEB_PREFERENCES).toEqual({
      contextIsolation: true, sandbox: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webSecurity: true,
      allowRunningInsecureContent: false, webviewTag: false, spellcheck: false, navigateOnDragDrop: false,
    });
    expect(Object.isFrozen(SECURE_WEB_PREFERENCES)).toBe(true);
  });
  it('main wires the policies (source check: index.ts uses them and sets no weaker webPreferences)', () => {
    const src = readFileSync(join(__dirname, '../../src/main/index.ts'), 'utf8');
    const wp = readFileSync(join(__dirname, '../../src/main/window-policy.ts'), 'utf8');
    expect(src).toContain('webPreferences: windowWebPreferences({');
    expect(wp).toContain('...SECURE_WEB_PREFERENCES');
    expect(wp).toContain('devTools: !o.isPackaged');
    expect(src).toContain('applySessionPolicy(ses');
    expect(src).toMatch(/web-contents-created[^\n]*hardenWebContents/);
    expect(src).toMatch(/will-navigate', onNav/);
    expect(src).toMatch(/will-redirect', onNav/);
    for (const weak of ['nodeIntegration: true', 'contextIsolation: false', 'sandbox: false', 'webSecurity: false', 'webviewTag: true', 'cb(true)'])
      expect(src).not.toContain(weak);
  });
  it('IPC accepts only the main frame of our window on the app origin', () => {
    const main = { url: 'pac://app/keys', parent: null };
    const win = { webContents: { mainFrame: main } };
    const ok = (u: string) => u.startsWith('pac://app/');
    expect(isTrustedSender({ sender: win.webContents, senderFrame: main }, win, ok)).toBe(true);
    expect(isTrustedSender({ sender: win.webContents, senderFrame: { url: 'pac://app/x', parent: main } }, win, ok)).toBe(false);
    expect(isTrustedSender({ sender: {}, senderFrame: { url: 'https://evil.test/', parent: null } }, win, ok)).toBe(false);
    expect(isTrustedSender({ sender: win.webContents, senderFrame: null }, win, ok)).toBe(false);
    expect(isTrustedSender({ sender: win.webContents, senderFrame: main }, null, ok)).toBe(false);
  });
});
