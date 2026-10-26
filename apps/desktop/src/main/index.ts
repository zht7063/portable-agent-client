import { consumeUninstallNonce } from './detach-all';
import { Shop } from './shop';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, protocol, safeStorage, session as electronSession, shell } from 'electron';
import { menuTemplate, windowWebPreferences } from './window-policy';
import { INVOKE_CHANNELS, PRODUCT, type InvokeChannel } from '@pac/core';
import { createKeyring, MemoryKeyring } from '@pac/keychain';
import { KeyFile } from '@pac/harness';
import { SERVER_ORIGIN } from './server-origin';
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
import { runUiSmokeStep } from './smoke-ui';
import { runKeysSmokeStep } from './smoke-keys';
import { KeyService } from './key-service';
import { buildAbout } from './about';
import { smokeAutoConfirmReveal } from './smoke-gate';
import { applySessionPolicy, hardenWebContents, type SessionLike, type WebContentsLike } from './security-policy';

/*
 * Main process: isolated window showing the patched upstream new-api web build on the privileged app protocol
 * (M2), IPC (config/harness) + keychain/pa-key wiring (M1), and (M3) the main-process server proxy: /api/* from the
 * renderer is forwarded by main to the configured server with a main-only session (see proxy/).
 */
/**
 * Build-time flag (esbuild --define, see scripts/build-main.mjs): true in dev/test builds, false in production
 * builds, where every smoke branch below folds to dead code and the smoke modules are tree-shaken out entirely.
 */
declare const __PA_SMOKE__: boolean;
/** Build-time: git commit (+ '-dirty') of the source this build was made from (Corresponding Source, AGPL §6). */
declare const __PA_BUILD_COMMIT__: string;
let win: BrowserWindow | null = null;
let shop: Shop | undefined;
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
    // macOS takes the icon from the app bundle (.icns); Windows/Linux use this PNG (copied to dist/ by build-main).
    ...(process.platform === 'darwin' ? {} : { icon: join(__dirname, '../icon.png') }),
    webPreferences: windowWebPreferences({ preload: join(__dirname, '../preload/index.cjs'), isPackaged: app.isPackaged }),
  });
  // Navigation only within app://; http(s) goes to the OS browser after confirmation; all else denied.
  const onNav = (e: Electron.Event, url: string) => {
    const d = navigationDecision(url, SCHEME, 'navigate');
    if (d.action === 'allow') return;
    e.preventDefault();
    if (d.action === 'external' && !(__PA_SMOKE__ && process.env.PA_SMOKE === '1')) void openExternalConfirmed(d.url);
  };
  w.webContents.on('will-navigate', onNav);
  w.webContents.on('will-redirect', onNav);
  hardenWebContents(w.webContents as unknown as WebContentsLike, (url) => {
    const d = navigationDecision(url, SCHEME, 'open');
    if (d.action === 'external' && !(__PA_SMOKE__ && process.env.PA_SMOKE === '1')) void openExternalConfirmed(d.url);
  });
  if ((__PA_SMOKE__ && process.env.PA_SMOKE === '1')) {
    if (process.env.PA_SMOKE_LOGIN === '1' && serverSession) runLoginSmoke(w, serverSession, (r, code) => { console.log('PA_SMOKE ' + JSON.stringify(r)); app.exit(code); }, smokeExtra);
    else runSmoke(w);
  }
  // Non-secret startup marker (also used by the packaged smoke, which cannot use PA_SMOKE in production builds).
  w.webContents.once('did-finish-load', () => console.log('[pac] renderer loaded'));
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

if ((__PA_SMOKE__ && process.env.PA_SMOKE === '1') && process.env.PA_USER_DATA) app.setPath('userData', process.env.PA_USER_DATA);

const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
app.on('second-instance', (_event, argv) => {
  if (argv.includes('--harness-detach-all')) return;
  win?.show(); win?.focus();
});
if (primaryInstance) app.whenReady().then(async () => {
  if (await consumeUninstallNonce(app.isPackaged, process.argv, app.getPath('userData'))) {
    const cleanup = new HarnessHost({ home: homedir(), dataDir: app.getPath('userData'), env: process.env, platform: process.platform });
    try { for (const id of ['codex', 'claude'] as const) await cleanup.harness.rollback(id, 'detach'); }
    finally { app.quit(); }
    return;
  }
  // Deny all permission requests/checks; cancel downloads; no webviews.
  const ses = electronSession.defaultSession;
  applySessionPolicy(ses as unknown as SessionLike);
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
  app.on('web-contents-created', (_e, wc) => { hardenWebContents(wc as unknown as WebContentsLike); });

  const userData = app.getPath('userData');
  const configStore = new ConfigStore(join(userData, 'config.json'), __PA_SMOKE__ && !app.isPackaged && process.env.PA_SMOKE === '1' ? process.env.PAC_SERVER_URL : SERVER_ORIGIN);
  const host = await CoreHost.start({
    configStore,
    tokenStore: createTokenStore(join(userData, 'session.bin')),
    onSessionChange: (v) => win?.webContents.send('session:changed', v),
  });
  const helperPath = ''; // Dev smoke compatibility only; never written into configs.
  const keyFile = new KeyFile(userData);
  const keyring = __PA_SMOKE__ && !app.isPackaged && process.env.PA_SMOKE === '1' ? createKeyring() : new MemoryKeyring();
  // M4: token -> keychain/clipboard through the main-only server session; the renderer only sends token ids.
  const keys = new KeyService({
    keyring, keyFile, api: (m, p) => srv.mainApi(m, p), clipboard: { writeText: (t) => clipboard.writeText(t), readText: () => clipboard.readText(), clear: () => clipboard.clear() },
    clipboardClearSeconds: () => host.config().clipboardClearSeconds,
    metaFile: join(userData, 'keychain-entries.json'),
    serverOrigin: () => srv.serverOrigin,
  });
  // Aegis N1: on quit, clear the clipboard if it still holds a key we copied.
  app.on('before-quit', () => { keys.clearClipboardIfOurs(); });
  app.on('will-quit', () => { keys.clearClipboardIfOurs(); });
  const harnessHost = new HarnessHost({
    home: homedir(), dataDir: userData, env: process.env, platform: process.platform, keyring, helperPath, getCore: () => host.core,
    keyFile, fetchKey: (id) => keys.fetchKey(id), serverOrigin: host.config().serverUrl ?? SERVER_ORIGIN,
  });
  if ((__PA_SMOKE__ && process.env.PA_SMOKE === '1') && process.env.PA_SMOKE_UI === '1') {
    smokeExtra = (js, secret) => runUiSmokeStep(js, secret, {
      tokenId: Number(process.env.PA_SMOKE_TOKEN_ID), keyring, helperPath, home: homedir(), shotDir: process.env.PA_SMOKE_SHOT_DIR,
      readClipboard: () => clipboard.readText(), clearClipboard: () => clipboard.clear(), revealShown: () => smokeRevealShown,
      click: async (x, y) => {
        if (!win) return;
        win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
        win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      },
      type: (text) => { win?.webContents.insertText(text); },
      shot: async () => (win ? (await win.webContents.capturePage()).toPNG() : Buffer.alloc(0)),
    });
  } else if ((__PA_SMOKE__ && process.env.PA_SMOKE === '1') && process.env.PA_SMOKE_KEYS === '1') {
    smokeExtra = (js, secret) => runKeysSmokeStep(js, secret, {
      tokenId: Number(process.env.PA_SMOKE_TOKEN_ID), serverUrl: host.config().serverUrl ?? '', keyring, helperPath, home: homedir(),
      readClipboard: () => clipboard.readText(), clearClipboard: () => clipboard.clear(),
    });
  }
  const handlers = createHandlers({
    shop: (action) => { if (!shop) throw new Error('Shop unavailable'); return shop.control(action); },
    harness: harnessHost.harness,
    harnessHost,
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
      if (__PA_SMOKE__ && smokeAutoConfirmReveal({ smokeBuild: __PA_SMOKE__, isPackaged: app.isPackaged, env: process.env })) return true; // dev UI smoke only (no user present)
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
      if ((__PA_SMOKE__ && process.env.PA_SMOKE === '1')) { smokeRevealShown = true; return; } // smoke: never render/print the key
      await (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts));
    },
    about: () => buildAbout({ product: PRODUCT, compat: compat as { tag: string; commit: string }, version: app.getVersion(), buildCommit: __PA_BUILD_COMMIT__ }),
    serverStatus: async (recheck) => {
      if (recheck) await srv.runCheck();
      const c = host.config();
      return {
        serverUrl: c.serverUrl, insecureTransport: c.insecureTransport, compat: compat as CompatRange,
        clientVersion: app.getVersion(), check: srv.serverCheck,
      };
    },
    confirmDisableClipboardClear: async () => {
      const opts = {
        type: 'warning' as const, buttons: ['取消', '关闭自动清除'], defaultId: 0, cancelId: 0, noLink: true, title: PRODUCT.productName,
        message: '关闭剪贴板自动清除？', detail: '复制的完整 API key 将一直留在系统剪贴板中，直到被覆盖（退出时仍会清除）。其他程序可能读取剪贴板。',
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
  shop = new Shop(win);
  installMenu();
  if (configStore.originChanged || (await harnessHost.harness.listProfiles()).some((p) => p.serverUrl !== host.config().serverUrl)) {
    await dialog.showMessageBox(win, { type: 'warning', title: 'Server changed', message: 'Select a token again', detail: 'The server origin changed. Sign in to this server and reselect a token on the Harness page before applying configurations.', buttons: ['OK'] });
  }
  try {
    const plan = await harnessHost.migration.plan();
    if (plan.needsMigration) {
      const choice = await dialog.showMessageBox(win, { type: 'warning', title: 'beta.1 migration', message: 'Review legacy harness cleanup', detail: `Remove legacy apiKeyHelper / pa-key references and provider pa from:\n${plan.files.join('\n')}\nRemove obsolete helper files:\n${plan.helpers.join('\n')}\nReset legacy ownership records: ${plan.ownership.map((o) => o.path).join('\n')}. Prior values remain in private backups.\nDiscard legacy profiles: ${plan.profiles.join(', ')}. Reselect a token on the Harness page. Private backups are retained. OS keychain entries are untouched; see docs/harness.md for manual deletion.`, buttons: ['Cancel', 'Migrate'], defaultId: 0, cancelId: 0, noLink: true });
      if (choice.response === 1) await harnessHost.migration.apply(plan);
    }
  } catch {
    await dialog.showMessageBox(win, { type: 'warning', title: 'Harness migration', message: 'Legacy self-check could not complete', detail: 'Self-check or migration could not complete. Review your agent configuration, private backups and docs/harness.md before retrying.', buttons: ['OK'] });
  }
});

/** M6: standard menus (no View menu / reload / DevTools when packaged, see window-policy.ts) plus Help -> "About & licenses" (AGPL notice, new-api attribution, source offer). */
function installMenu() {
  const about = { label: 'About & licenses', click: () => { void win?.loadURL(`${APP_URL}pa-about`); } };
  const template = menuTemplate({ isPackaged: app.isPackaged, platform: process.platform, about });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Shows compatibility / Turnstile / non-HTTPS findings once (warning only for HTTP; blocking states also gate login). */
let lastReported = '';
function reportServerCheck(c: ServerCheck | null) {
  // Background retries while unreachable report the same finding again: show each distinct finding once.
  const k = c ? `${c.verdict}|${c.messages.join('|')}` : '';
  if (k === lastReported) return;
  lastReported = k;
  if (!c || !c.messages.length) return;
  console.log(`[pac] server check: ${c.verdict} version=${c.serverVersion ?? '-'} allowLogin=${c.allowLogin}`);
  if ((__PA_SMOKE__ && process.env.PA_SMOKE === '1')) return;
  const opts = {
    type: (c.allowLogin ? 'warning' : 'error') as 'warning' | 'error', buttons: ['确定'], noLink: true, title: PRODUCT.productName,
    message: c.allowLogin ? '服务器连接提示' : '无法在客户端内登录该服务器', detail: c.messages.join('\n\n'),
  };
  void (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts));
}

app.on('window-all-closed', () => app.quit());
