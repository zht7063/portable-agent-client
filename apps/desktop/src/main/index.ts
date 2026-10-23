import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { app, BrowserWindow, clipboard, dialog, ipcMain, protocol, safeStorage, session as electronSession, shell } from 'electron';
import { INVOKE_CHANNELS, PRODUCT, type InvokeChannel } from '@pac/core';
import { createKeyring } from '@pac/keychain';
import { installWrapper } from '@pac/pa-key';
import { isTrustedSender, untrustedSender } from './ipc/sender';
import { createTokenStore } from './safe-storage-store';
import { createHandlers, dispatch } from './ipc/handlers';
import { ConfigStore } from './config-store';
import { CoreHost } from './core-host';
import { HarnessHost } from './harness-host';
import { appOrigin, buildCsp, handleAppRequest, isAppUrl, navigationDecision } from './app-protocol';
import { ServerSession } from './proxy/server-session';
import type { CompatRange, ServerCheck } from './proxy/server-status';
import compat from '../../../../compat.json';
import { runLoginSmoke, type SmokeExtra } from './smoke-login';
import { runKeysSmokeStep } from './smoke-keys';
import { KeyService } from './key-service';
import { serverChangeDialog } from './dialogs';

/*
 * Main process: isolated window showing the patched upstream new-api web build on the privileged app protocol
 * (M2), IPC (config/harness) + keychain/pa-key wiring (M1), and (M3) the main-process server proxy: /api/* from the
 * renderer is forwarded by main to the configured server with a main-only session (see proxy/).
 */
let win: BrowserWindow | null = null;
let serverSession: ServerSession | null = null;
let smokeExtra: SmokeExtra | undefined;
/** Smoke only: set when the native "Show key" box would have been shown (the key is never printed). */
let smokeRevealShown = false;

const SCHEME = PRODUCT.protocolScheme;
const RENDERER_ROOT = join(__dirname, '../renderer');
const APP_URL = `${appOrigin(SCHEME)}/`;
/** IPC is accepted only from our app:// origin (any SPA route). */
const isRendererUrl = (u: string) => isAppUrl(u, SCHEME);

// Must run before app 'ready': standard+secure so the origin behaves like https (storage, fetch, CSP 'self').
protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false, stream: true, codeCache: true } },
]);

app.setName(PRODUCT.productName);

async function openExternalConfirmed(url: string) {
  const opts = {
    // Aegis #6: full URL (punycode host) shown, Cancel is default and the Escape action.
    type: 'warning' as const, buttons: ['取消', '在浏览器中打开'], defaultId: 0, cancelId: 0, noLink: true,
    title: PRODUCT.productName, message: `在系统浏览器中打开外部站点 ${new URL(url).host}？`,
    detail: `完整地址：\n${url}\n\n该链接来自页面内容，请确认地址可信后再打开。`,
  };
  const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
  if (r.response === 1) await shell.openExternal(url);
}

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1280,
    height: 820,
    title: PRODUCT.productName,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      navigateOnDragDrop: false,
    },
  });
  // Navigation only within app://; http(s) goes to the OS browser after confirmation; all else denied.
  const onNav = (e: Electron.Event, url: string) => {
    const d = navigationDecision(url, SCHEME, 'navigate');
    if (d.action === 'allow') return;
    e.preventDefault();
    if (d.action === 'external' && process.env.PA_SMOKE !== '1') void openExternalConfirmed(d.url);
  };
  w.webContents.on('will-navigate', onNav);
  w.webContents.on('will-redirect', onNav);
  w.webContents.on('will-attach-webview', (e) => e.preventDefault());
  w.webContents.setWindowOpenHandler(({ url }) => {
    const d = navigationDecision(url, SCHEME, 'open');
    if (d.action === 'external' && process.env.PA_SMOKE !== '1') void openExternalConfirmed(d.url);
    return { action: 'deny' };
  });
  if (process.env.PA_SMOKE === '1') {
    if (process.env.PA_SMOKE_LOGIN === '1' && serverSession) runLoginSmoke(w, serverSession, (r, code) => { console.log('PA_SMOKE ' + JSON.stringify(r)); app.exit(code); }, smokeExtra);
    else runSmoke(w);
  }
  void w.loadURL(APP_URL);
  return w;
}

/** Dev smoke check (PA_SMOKE=1): isolation + bridge + upstream UI render + CSP + /api stub; optional screenshot. */
function runSmoke(w: BrowserWindow) {
  const finish = (r: unknown, code: number) => { console.log('PA_SMOKE ' + JSON.stringify(r)); app.exit(code); };
  const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }, 1), 45000);
  w.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      w.webContents.executeJavaScript(`(async () => {
        const res = await fetch('/api/status');
        const page = await fetch('/');
        let evalBlocked = false; try { new Function('return 1')(); } catch { evalBlocked = true; }
        let remoteBlocked = false; try { await fetch('https://example.com/'); } catch { remoteBlocked = true; }
        return {
          url: location.href,
          bridge: typeof window.pa?.config?.get === 'function' && typeof window.pa?.onSessionChanged === 'function' && !('invoke' in window.pa),
          noNode: typeof require === 'undefined' && typeof process === 'undefined',
          rendered: (document.getElementById('root')?.childElementCount ?? 0) > 0,
          title: document.title,
          apiStatus: res.status,
          csp: page.headers.get('content-security-policy'),
          inlineScripts: [...document.scripts].filter((x) => !x.src).length,
          evalBlocked, remoteBlocked,
          config: (await window.pa.config.get()).ok,
        };
      })()`).then(async (r: Record<string, unknown>) => {
        clearTimeout(timer);
        if (process.env.PA_SMOKE_SCREENSHOT) {
          const img = await w.webContents.capturePage();
          writeFileSync(process.env.PA_SMOKE_SCREENSHOT, img.toPNG());
        }
        // No server configured in the basic smoke: the proxy answers 503 NO_SERVER without any network access.
        const ok = r.bridge && r.noNode && r.rendered && r.apiStatus === 503 && r.csp === buildCsp(SCHEME) && r.inlineScripts === 0 && r.evalBlocked && r.remoteBlocked && r.config;
        finish(r, ok ? 0 : 1);
      }, (e: unknown) => { clearTimeout(timer); finish({ ok: false, reason: String(e) }, 1); });
    }, Number(process.env.PA_SMOKE_WAIT_MS ?? 6000));
  });
}

if (process.env.PA_SMOKE === '1' && process.env.PA_USER_DATA) app.setPath('userData', process.env.PA_USER_DATA);

app.whenReady().then(async () => {
  // Deny all permission requests/checks; cancel downloads; no webviews.
  const ses = electronSession.defaultSession;
  ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.on('will-download', (e) => e.preventDefault());
  const cipher = safeStorage.isEncryptionAvailable()
    ? { encrypt: (x: string) => safeStorage.encryptString(x), decrypt: (b: Buffer) => safeStorage.decryptString(b) } : null;
  const srv = new ServerSession({
    compat: compat as CompatRange,
    // Node (undici) fetch: no Chromium cookie store involved; cookies are only what the main-only jar attaches.
    fetch: (url, init) => globalThis.fetch(url, init),
    file: join(app.getPath('userData'), 'server-session.bin'),
    cipher,
    onCheck: (c) => reportServerCheck(c),
  });
  serverSession = srv;
  ses.protocol.handle(SCHEME, (req) => handleAppRequest({ url: req.url, method: req.method }, RENDERER_ROOT, SCHEME, undefined,
    async () => srv.handle({ method: req.method, url: req.url, headers: req.headers, body: req.method === 'GET' || req.method === 'HEAD' ? null : await req.arrayBuffer() })));
  app.on('web-contents-created', (_e, wc) => {
    wc.on('will-attach-webview', (ev) => ev.preventDefault());
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  });

  const userData = app.getPath('userData');
  const host = await CoreHost.start({
    // PAC_SERVER_URL only seeds an unconfigured client (dev); a saved config.json wins. No built-in default server.
    configStore: new ConfigStore(join(userData, 'config.json'), process.env.PAC_SERVER_URL),
    tokenStore: createTokenStore(join(userData, 'session.bin')),
    onSessionChange: (v) => win?.webContents.send('session:changed', v),
  });
  // D4: pa-key wrapper lives in the client's own directory; harness configs reference its absolute path.
  // Packaged: the script is asarUnpack'ed so ELECTRON_RUN_AS_NODE can load it (and resolve @napi-rs/keyring) from disk.
  const helperScript = join(__dirname, '../key-helper/pa-key.cjs').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  let helperPath = join(userData, 'bin', process.platform === 'win32' ? 'pa-key.cmd' : 'pa-key');
  try { helperPath = await installWrapper({ dir: join(userData, 'bin'), execPath: process.execPath, scriptPath: helperScript }); }
  catch { /* harness page reports the helper as missing */ }
  const keyring = createKeyring();
  // M4: token -> keychain/clipboard through the main-only server session; the renderer only sends token ids.
  const keys = new KeyService({
    keyring, api: (m, p) => srv.mainApi(m, p), clipboard: { writeText: (t) => clipboard.writeText(t), readText: () => clipboard.readText(), clear: () => clipboard.clear() },
    clipboardClearSeconds: () => host.config().clipboardClearSeconds,
    metaFile: join(userData, 'keychain-entries.json'),
  });
  // Aegis N1: on quit, clear the clipboard if it still holds a key we copied.
  app.on('before-quit', () => { keys.clearClipboardIfOurs(); });
  app.on('will-quit', () => { keys.clearClipboardIfOurs(); });
  const harnessHost = new HarnessHost({
    home: homedir(), dataDir: userData, env: process.env, platform: process.platform, keyring, helperPath, getCore: () => host.core,
    ensureKey: (profileId, h, tokenId) => keys.ensure(profileId, h, tokenId),
  });
  if (process.env.PA_SMOKE === '1' && process.env.PA_SMOKE_KEYS === '1') {
    smokeExtra = (js, secret) => runKeysSmokeStep(js, secret, {
      tokenId: Number(process.env.PA_SMOKE_TOKEN_ID), serverUrl: host.config().serverUrl ?? '', keyring, helperPath, home: homedir(),
      readClipboard: () => clipboard.readText(), clearClipboard: () => clipboard.clear(),
    });
  }
  const handlers = createHandlers({
    harness: harnessHost.harness,
    keys,
    getCore: () => host.core,
    getConfig: () => host.config(),
    setConfig: async (patch) => {
      const c = await host.set(patch);
      await srv.setServer(c.serverUrl);
      void srv.runCheck();
      return c;
    },
    // M5 "Show key": confirm natively (Cancel default), then show the key in a native box; never in the renderer.
    confirmRevealKey: async (tokenId) => {
      const opts = {
        type: 'warning' as const, buttons: ['取消', '显示 key'], defaultId: 0, cancelId: 0, noLink: true,
        title: PRODUCT.productName, message: `显示令牌 #${tokenId} 的完整 API key？`,
        detail: '完整 key 将显示在系统对话框中（不会进入页面）。请确认周围无人旁观、未在录屏或共享屏幕。',
      };
      const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
      return r.response === 1;
    },
    showKey: async (fullKey, tokenId) => {
      const opts = { type: 'info' as const, buttons: ['关闭'], defaultId: 0, cancelId: 0, noLink: true, title: PRODUCT.productName, message: `令牌 #${tokenId} 的 API key`, detail: fullKey };
      if (process.env.PA_SMOKE === '1') { smokeRevealShown = true; return; } // smoke: never render/print the key
      await (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts));
    },
    serverStatus: async (recheck) => {
      if (recheck) await srv.runCheck();
      const c = host.config();
      return {
        serverUrl: c.serverUrl, insecureTransport: c.insecureTransport, compat: compat as CompatRange,
        clientVersion: app.getVersion(), check: srv.serverCheck,
      };
    },
    confirmServerChange: async (nextUrl, currentUrl) => {
      const opts = { ...serverChangeDialog(nextUrl, currentUrl), title: PRODUCT.productName };
      const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
      return r.response === 1;
    },
    confirmForeignServer: async (profileOrigin, clientOrigin) => {
      const opts = {
        type: 'warning' as const, buttons: ['取消', '仍然使用该服务器'], defaultId: 0, cancelId: 0, noLink: true,
        title: PRODUCT.productName, message: 'Harness 配置指向另一个服务器',
        detail: `配置中的服务器：${profileOrigin}\n客户端当前服务器：${clientOrigin || '(未配置)'}\n\n只有你信任该服务器时才继续：你的 API key 会被发送到那里。`,
      };
      const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
      return r.response === 1;
    },
  });
  for (const ch of INVOKE_CHANNELS) {
    ipcMain.handle(ch, (e, req) => (isTrustedSender(e, win, isRendererUrl) ? dispatch(handlers, ch as InvokeChannel, req) : untrustedSender()));
  }
  // M3 §4: public /api/status check before any login; result cached in main (login gated in the proxy).
  await srv.setServer(host.config().serverUrl);
  // Reported via onCheck (also for background retries while unreachable).
  await srv.runCheck();
  // Handlers are registered before the renderer loads, so its first invoke never races.
  win = createWindow();
});

/** Shows compatibility / Turnstile / non-HTTPS findings once (warning only for HTTP; blocking states also gate login). */
let lastReported = '';
function reportServerCheck(c: ServerCheck | null) {
  // Background retries while unreachable report the same finding again: show each distinct finding once.
  const k = c ? `${c.verdict}|${c.messages.join('|')}` : '';
  if (k === lastReported) return;
  lastReported = k;
  if (!c || !c.messages.length) return;
  console.log(`[pac] server check: ${c.verdict} version=${c.serverVersion ?? '-'} allowLogin=${c.allowLogin}`);
  if (process.env.PA_SMOKE === '1') return;
  const opts = {
    type: (c.allowLogin ? 'warning' : 'error') as 'warning' | 'error', buttons: ['确定'], noLink: true, title: PRODUCT.productName,
    message: c.allowLogin ? '服务器连接提示' : '无法在客户端内登录该服务器', detail: c.messages.join('\n\n'),
  };
  void (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts));
}

app.on('window-all-closed', () => app.quit());
