import { WebContentsView, session, dialog, shell, type BrowserWindow } from 'electron';
import { SHOP_LINK_GESTURE_SETUP, shopTakeLinkGesture } from './shop-gesture';
import { applySessionPolicy, type SessionLike } from './security-policy';
import { SHOP_PARTITION, SHOP_URL, SHOP_WEB_PREFERENCES, shopUrlDecision, shopWindowOpen, shopCanPrompt, nextShopConfirm, type ShopConfirmState, type ShopAction } from './shop-policy';

/** Remote content never receives a preload or an IPC bridge. Only the app window controls this view. */
export class Shop {
  private view?: WebContentsView;
  private visible = false;
  private prompting = false;
  private confirms: ShopConfirmState = { urls: new Map() };
  constructor(private win: BrowserWindow) {
    win.on('resize', () => this.bounds());
    win.webContents.on('zoom-changed', () => this.bounds());
    win.webContents.on('did-start-navigation', (_e, _url, _inPlace, mainFrame) => { if (mainFrame) this.hide(); });
    win.on('closed', () => { this.view?.webContents.close(); this.view = undefined; });
  }
  private bounds() {
    if (!this.view) return;
    const [width = 0, height = 0] = this.win.getContentSize();
    const top = Math.ceil(144 * this.win.webContents.getZoomFactor());
    this.view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
  }
  private hide() { this.visible = false; this.view?.setVisible(false); }
  private async external(url: string) {
    if (this.win.isDestroyed() || shopUrlDecision(url) === 'deny') return;
    const next = nextShopConfirm(this.confirms, url, Date.now(), this.prompting);
    if (!next) return;
    this.confirms = next;
    this.prompting = true;
    // Hide the native view so it cannot obscure app or native confirmation UI.
    this.view?.setVisible(false);
    try {
      const r = await dialog.showMessageBox(this.win, { type: 'warning', title: 'Shop', message: '打开商城外部链接？', detail: url, buttons: ['取消', '打开'], defaultId: 0, cancelId: 0, noLink: true });
      if (r.response === 1 && !this.win.isDestroyed()) await shell.openExternal(url);
    } finally { this.prompting = false; if (!this.win.isDestroyed()) this.view?.setVisible(this.visible); }
  }
  private ensure() {
    if (this.view) return this.view;
    const ses = session.fromPartition(SHOP_PARTITION);
    applySessionPolicy(ses as unknown as SessionLike);
    const view = new WebContentsView({ webPreferences: { ...SHOP_WEB_PREFERENCES, session: ses } });
    this.view = view;
    view.setVisible(false);
    this.win.contentView.addChildView(view);
    const wc = view.webContents;
    // Frame events and redirects enforce policy only; they never prompt.
    const block = (e: Electron.Event, url: string) => {
      if (shopUrlDecision(url) !== 'view') e.preventDefault();
    };
    // Top-level navigations cannot distinguish a script redirect from a real click
    // (Aegis r37 7-1), so non-allowlisted targets are blocked without any dialog.
    // Users can still leave via the click-verified window.open path or "Open in browser".
    wc.on('will-navigate', block);
    wc.on('will-redirect', block);
    wc.on('will-frame-navigate', e => { if (!e.isMainFrame) block(e, e.url); });
    let documentGeneration = 0;
    wc.on('did-start-navigation', (_e, _url, _inPlace, mainFrame) => { if (mainFrame) documentGeneration++; });
    wc.on('dom-ready', () => {
      void wc.executeJavaScriptInIsolatedWorld(999, [{ code: SHOP_LINK_GESTURE_SETUP }]).catch(() => {});
    });
    wc.setWindowOpenHandler(shopWindowOpen(url => { void wc.loadURL(url).catch(() => {}); }, url => {
      if (this.prompting || !shopCanPrompt(url)) return;
      const generation = documentGeneration;
      // HandlerDetails exposes neither opener frame nor gesture. Fail closed
      // unless this URL matches a trusted link clicked in the main document.
      void wc.executeJavaScriptInIsolatedWorld(999, [{ code: shopTakeLinkGesture(url) }])
        .then(active => { if (active === true && this.view === view && generation === documentGeneration) return this.external(url); })
        .catch(() => {});
    }));
    const host = () => { if (!this.win.isDestroyed()) this.win.webContents.send('shop:host', this.host()); };
    wc.on('did-navigate', host);
    wc.on('did-navigate-in-page', host);
    void wc.loadURL(SHOP_URL).catch(() => {});
    return view;
  }
  private host() { try { return new URL(this.view?.webContents.getURL() || SHOP_URL).host; } catch { return ''; } }
  async control(action: ShopAction): Promise<{ host: string }> {
    if (action === 'hide') this.hide();
    else if (action === 'show') { const v = this.ensure(); this.visible = true; this.bounds(); v.setVisible(!this.prompting); }
    else if (action === 'reload') this.ensure().webContents.reload();
    else if (action === 'open-in-browser') await this.external(this.view?.webContents.getURL() || SHOP_URL);
    else if (action === 'clear-data') {
      this.hide();
      this.view?.webContents.close();
      if (this.view) this.win.contentView.removeChildView(this.view);
      this.view = undefined;
      const ses = session.fromPartition(SHOP_PARTITION);
      await ses.clearStorageData();
      await ses.clearCache();
      await ses.clearAuthCache();
      await ses.closeAllConnections();
    }
    return { host: this.host() };
  }
}
