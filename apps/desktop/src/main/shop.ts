import { WebContentsView, session, dialog, shell, type BrowserWindow } from 'electron';
import { applySessionPolicy, type SessionLike } from './security-policy';
import { SHOP_PARTITION, SHOP_URL, SHOP_WEB_PREFERENCES, shopUrlDecision, shopWindowOpen, type ShopAction } from './shop-policy';

/** Remote content never receives a preload or an IPC bridge. Only the app window controls this view. */
export class Shop {
  private view?: WebContentsView;
  private visible = false;
  private prompting = false;
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
    if (this.prompting || this.win.isDestroyed() || shopUrlDecision(url) === 'deny') return;
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
    const navigate = (e: Electron.Event, url: string) => {
      if (shopUrlDecision(url) === 'view') return;
      e.preventDefault();
      if (shopUrlDecision(url) === 'external') void this.external(url).catch(() => {});
    };
    wc.on('will-navigate', navigate);
    wc.on('will-redirect', navigate);
    wc.on('will-frame-navigate', (e) => navigate(e, e.url));
    wc.setWindowOpenHandler(shopWindowOpen(url => { void wc.loadURL(url).catch(() => {}); }, url => { void this.external(url).catch(() => {}); }));
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
