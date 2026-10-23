import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { app, BrowserWindow, dialog, ipcMain, session as electronSession, shell } from 'electron';
import { INVOKE_CHANNELS, PRODUCT, type InvokeChannel } from '@pac/core';
import { createKeyring } from '@pac/keychain';
import { installWrapper } from '@pac/pa-key';
import { isTrustedSender, untrustedSender } from './ipc/sender';
import { createTokenStore } from './safe-storage-store';
import { createHandlers, dispatch } from './ipc/handlers';
import { ConfigStore } from './config-store';
import { CoreHost } from './core-host';
import { HarnessHost } from './harness-host';

/*
 * M1 minimal main process: isolated window + IPC (config/harness) + keychain/pa-key wiring.
 * M2 replaces the placeholder renderer (file://) with the upstream web build on app://; M3 adds the API proxy.
 */
let win: BrowserWindow | null = null;

const RENDERER_PATH = join(__dirname, '../renderer/index.html');
/** The only origin allowed to call IPC: our bundled renderer. */
const RENDERER_URL = pathToFileURL(RENDERER_PATH).href;

app.setName(PRODUCT.productName);

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1100,
    height: 760,
    title: PRODUCT.productName,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
      spellcheck: false,
    },
  });
  // Block navigation and new windows; external https links open in the OS browser only.
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  w.webContents.on('did-finish-load', () => {
    void w.webContents.executeJavaScript(`document.title = ${JSON.stringify(PRODUCT.productName)}; document.getElementById('product').textContent = document.title;`);
  });
  if (process.env.PA_SMOKE === '1') runSmoke(w);
  void w.loadFile(RENDERER_PATH);
  return w;
}

/** Dev smoke check (PA_SMOKE=1): verify isolation + bridge + first render, print JSON, quit. */
function runSmoke(w: BrowserWindow) {
  const finish = (r: unknown, code: number) => { console.log('PA_SMOKE ' + JSON.stringify(r)); app.exit(code); };
  const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }, 1), 20000);
  w.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      w.webContents.executeJavaScript(`(async () => ({
        bridge: typeof window.pa?.invoke === 'function' && typeof window.pa?.on === 'function',
        noNode: typeof require === 'undefined' && typeof process === 'undefined',
        title: document.getElementById('product')?.textContent ?? null,
        config: (await window.pa.invoke('config:get', {})).ok,
      }))()`).then((r: Record<string, unknown>) => {
        clearTimeout(timer);
        finish(r, r.bridge && r.noNode && r.title === PRODUCT.productName && r.config ? 0 : 1);
      }, (e: unknown) => { clearTimeout(timer); finish({ ok: false, reason: String(e) }, 1); });
    }, 1000);
  });
}

if (process.env.PA_SMOKE === '1' && process.env.PA_USER_DATA) app.setPath('userData', process.env.PA_USER_DATA);

app.whenReady().then(async () => {
  // Deny all permission requests; cancel downloads.
  electronSession.defaultSession.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  electronSession.defaultSession.on('will-download', (e) => e.preventDefault());

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
  const harnessHost = new HarnessHost({
    home: homedir(), dataDir: userData, env: process.env, platform: process.platform, keyring: createKeyring(), helperPath, getCore: () => host.core,
  });
  const handlers = createHandlers({
    harness: harnessHost.harness,
    getCore: () => host.core,
    getConfig: () => host.config(),
    setConfig: (patch) => host.set(patch),
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
    ipcMain.handle(ch, (e, req) => (isTrustedSender(e, win, RENDERER_URL) ? dispatch(handlers, ch as InvokeChannel, req) : untrustedSender()));
  }
  // Handlers are registered before the renderer loads, so its first invoke never races.
  win = createWindow();
});

app.on('window-all-closed', () => app.quit());
