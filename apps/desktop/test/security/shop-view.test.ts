import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';

const mocks = vi.hoisted(() => ({ fromPartition: vi.fn(), dialog: vi.fn(), openExternal: vi.fn(), views: [] as MockView[] }));
class MockView {
  webContents = Object.assign(new EventEmitter(), {
    loadURL: vi.fn().mockResolvedValue(undefined), close: vi.fn(), reload: vi.fn(), getURL: () => 'https://wzyp.cn/',
    executeJavaScriptInIsolatedWorld: vi.fn().mockResolvedValue(false),
    setWindowOpenHandler: vi.fn(),
  });
  setBounds = vi.fn();
  setVisible = vi.fn();
  constructor(public options: unknown) { mocks.views.push(this); }
}
vi.mock('electron', () => ({ WebContentsView: class { constructor(options: unknown) { return new MockView(options); } }, session: { fromPartition: mocks.fromPartition }, dialog: { showMessageBox: mocks.dialog }, shell: { openExternal: mocks.openExternal } }));
import { Shop } from '../../src/main/shop';

function setup() {
  const ses = { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), setDevicePermissionHandler: vi.fn(), on: vi.fn(), clearStorageData: vi.fn(), clearCache: vi.fn(), clearAuthCache: vi.fn(), closeAllConnections: vi.fn() };
  mocks.fromPartition.mockReturnValue(ses);
  const win = Object.assign(new EventEmitter(), { webContents: Object.assign(new EventEmitter(), { getZoomFactor: vi.fn(() => 1), send: vi.fn() }), getContentSize: vi.fn(() => [1000, 800]), isDestroyed: () => false, contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } });
  return { ses, win, shop: new Shop(win as unknown as BrowserWindow) };
}
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
describe('Shop Electron wiring', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.views.length = 0; mocks.dialog.mockResolvedValue({ response: 0 }); });
  it('uses its isolated session and secure preferences, sizes on show/resize and clears the view and session', async () => {
    const { shop, win, ses } = setup();
    await shop.control('show');
    const view = mocks.views[0]!;
    expect(mocks.fromPartition).toHaveBeenCalledWith('persist:shop');
    expect(view.options).toMatchObject({ webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false, webSecurity: true } });
    expect((view.options as { webPreferences: object }).webPreferences).not.toHaveProperty('preload');
    expect(win.contentView.addChildView).toHaveBeenCalledWith(view);
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 144, width: 1000, height: 656 });
    win.getContentSize.mockReturnValue([600, 100]); win.emit('resize');
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 144, width: 600, height: 0 });
    win.webContents.getZoomFactor.mockReturnValue(2); win.webContents.emit('zoom-changed');
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 288, width: 600, height: 0 });
    const cb = vi.fn(); ses.setPermissionRequestHandler.mock.calls[0]![0](null, 'clipboard-read', cb);
    expect(cb).toHaveBeenCalledWith(false);
    expect(ses.setPermissionCheckHandler.mock.calls[0]![0]()).toBe(false);
    expect(ses.setDevicePermissionHandler.mock.calls[0]![0]()).toBe(false);
    await shop.control('clear-data');
    for (const fn of [ses.clearStorageData, ses.clearCache, ses.clearAuthCache, ses.closeAllConnections, view.webContents.close]) expect(fn).toHaveBeenCalledOnce();
    expect(win.contentView.removeChildView).toHaveBeenCalledWith(view);
    await shop.control('show'); expect(mocks.views).toHaveLength(2);
  });
  it('silently blocks subframes and redirects', async () => {
    const { shop } = setup(); await shop.control('show'); const wc = mocks.views[0]!.webContents;
    for (const event of ['will-frame-navigate', 'will-redirect']) {
      const e = { preventDefault: vi.fn(), url: 'https://evil.com/', isMainFrame: false };
      wc.emit(event, e, e.url); expect(e.preventDefault).toHaveBeenCalledOnce();
    }
    const childTop = { preventDefault: vi.fn(), isMainFrame: true, initiator: {} };
    wc.emit('will-navigate', childTop, 'https://evil.com/'); expect(childTop.preventDefault).toHaveBeenCalledOnce();
    const mainRedirect = { preventDefault: vi.fn(), isMainFrame: true };
    wc.emit('will-redirect', mainRedirect, 'https://evil.com/');
    expect(mainRedirect.preventDefault).toHaveBeenCalledOnce();
    for (const url of ['file:///secret', 'weixin://pay/']) {
      const event = { preventDefault: vi.fn(), isMainFrame: true };
      wc.emit('will-navigate', event, url); expect(event.preventDefault).toHaveBeenCalledOnce();
    }
    const allowed = { preventDefault: vi.fn(), url: 'https://captcha.aliyun.com/', isMainFrame: false };
    wc.emit('will-frame-navigate', allowed); expect(allowed.preventDefault).not.toHaveBeenCalled();
    await tick(); expect(mocks.dialog).not.toHaveBeenCalled();
  });
  it('silently blocks every non-allowlisted top-level navigation, even ones that look user-initiated (r37 7-1)', async () => {
    const { shop } = setup(); await shop.control('show'); const wc = mocks.views[0]!.webContents;
    for (let i = 0; i < 5; i++) {
      const e = { preventDefault: vi.fn(), isMainFrame: true, initiator: undefined };
      wc.emit('will-navigate', e, `https://evil${i}.com/`); expect(e.preventDefault).toHaveBeenCalledOnce();
    }
    const ok = { preventDefault: vi.fn(), isMainFrame: true };
    wc.emit('will-navigate', ok, 'https://wzyp.cn/shop/x'); expect(ok.preventDefault).not.toHaveBeenCalled();
    await tick(); expect(mocks.dialog).not.toHaveBeenCalled(); expect(mocks.openExternal).not.toHaveBeenCalled();
  });
  it('drops overlapping confirms, throttles all URLs and deduplicates for 30 seconds', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(100_000);
    try {
      const { shop } = setup(); await shop.control('show'); const wc = mocks.views[0]!.webContents;
      wc.executeJavaScriptInIsolatedWorld.mockResolvedValue(true);
      const handler = wc.setWindowOpenHandler.mock.calls[0]![0];
      const nav = (url: string) => { handler({ url }); };
      let finish!: (value: { response: number }) => void;
      mocks.dialog.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      nav('https://one.com/'); await tick(); now.mockReturnValue(105_000); nav('https://two.com/'); await tick();
      expect(mocks.dialog).toHaveBeenCalledTimes(1); finish({ response: 0 }); await tick();
      now.mockReturnValue(106_000); nav('https://one.com/'); await tick(); expect(mocks.dialog).toHaveBeenCalledTimes(1);
      nav('https://two.com/'); await tick(); expect(mocks.dialog).toHaveBeenCalledTimes(2);
      now.mockReturnValue(107_000); nav('https://three.com/'); await tick(); expect(mocks.dialog).toHaveBeenCalledTimes(2);
      now.mockReturnValue(130_000); nav('https://one.com/'); await tick(); expect(mocks.dialog).toHaveBeenCalledTimes(3);
    } finally { now.mockRestore(); }
  });
  it('requires a trusted main-document link for external window.open and always denies child windows', async () => {
    const { shop } = setup(); await shop.control('show'); const wc = mocks.views[0]!.webContents;
    wc.emit('dom-ready');
    expect(wc.executeJavaScriptInIsolatedWorld).toHaveBeenCalledWith(999, [{ code: expect.stringContaining("document.addEventListener('click'") }]);
    const handler = wc.setWindowOpenHandler.mock.calls[0]![0];
    expect(handler({ url: 'https://evil.com/' })).toEqual({ action: 'deny' }); await tick();
    expect(mocks.dialog).not.toHaveBeenCalled();
    wc.executeJavaScriptInIsolatedWorld.mockRejectedValueOnce(new Error('frame destroyed'));
    handler({ url: 'https://evil.com/' }); await tick(); expect(mocks.dialog).not.toHaveBeenCalled();
    wc.executeJavaScriptInIsolatedWorld.mockResolvedValue(true);
    handler({ url: 'weixin://pay/' }); await tick(); expect(mocks.dialog).not.toHaveBeenCalled();
    mocks.dialog.mockResolvedValue({ response: 1 });
    handler({ url: 'https://evil.com/' }); await tick(); expect(mocks.dialog).toHaveBeenCalledOnce();
    expect(mocks.openExternal).toHaveBeenCalledWith('https://evil.com/');
  });
  it('drops popup requests while a dialog is open and ignores stale document checks', async () => {
    const { shop } = setup(); await shop.control('show'); const wc = mocks.views[0]!.webContents;
    const handler = wc.setWindowOpenHandler.mock.calls[0]![0];
    let resolveGesture!: (active: boolean) => void;
    wc.executeJavaScriptInIsolatedWorld.mockImplementationOnce(() => new Promise(resolve => { resolveGesture = resolve; }));
    handler({ url: 'https://stale.com/' });
    wc.emit('did-start-navigation', {}, 'https://wzyp.cn/', false, true);
    resolveGesture(true); await tick(); expect(mocks.dialog).not.toHaveBeenCalled();
    let closeDialog!: (result: { response: number }) => void;
    mocks.dialog.mockImplementationOnce(() => new Promise(resolve => { closeDialog = resolve; }));
    wc.executeJavaScriptInIsolatedWorld.mockResolvedValueOnce(true);
    handler({ url: 'https://one.com/' }); await tick();
    const calls = wc.executeJavaScriptInIsolatedWorld.mock.calls.length;
    handler({ url: 'https://two.com/' });
    expect(wc.executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(calls);
    closeDialog({ response: 0 }); await tick(); expect(mocks.dialog).toHaveBeenCalledOnce();
  });

});
