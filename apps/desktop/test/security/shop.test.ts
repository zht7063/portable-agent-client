import { describe, it, expect, vi } from 'vitest';
import { SHOP_WEB_PREFERENCES, shopUrlDecision, shopWindowOpen, isShopRequest, nextShopConfirm, shopCanPrompt } from '../../src/main/shop-policy';
import { applySessionPolicy } from '../../src/main/security-policy';
import { isTrustedSender } from '../../src/main/ipc/sender';

describe('isolated shop', () => {
  it('only automatically prompts for non-allowlisted HTTPS', () => {
    expect(shopCanPrompt('https://evil.com/')).toBe(true);
    for (const url of ['https://wzyp.cn/', 'weixin://pay/', 'alipays://pay/', 'http://evil.com/', 'invalid']) expect(shopCanPrompt(url)).toBe(false);
  });
  it('keeps confirmation timing transitions pure and canonicalizes identical URLs', () => {
    const initial = { urls: new Map<string, number>() };
    const first = nextShopConfirm(initial, 'https://EVIL.com:443', 0, false)!;
    expect(initial.urls.size).toBe(0);
    expect(nextShopConfirm(first, 'https://other.com/', 2999, false)).toBeUndefined();
    expect(nextShopConfirm(first, 'https://other.com/', 3000, true)).toBeUndefined();
    expect(nextShopConfirm(first, 'https://evil.com/', 29_999, false)).toBeUndefined();
    expect(nextShopConfirm(first, 'https://other.com/', 3000, false)).toBeDefined();
    const expired = nextShopConfirm(first, 'https://other.com/', 30_000, false)!;
    expect(expired.urls.has('https://evil.com/')).toBe(false);
  });
  it('only permits explicit HTTPS hosts in view', () => {
    for (const u of ['https://wzyp.cn/shop/x', 'https://a.wzyp.cn/', 'https://captcha.aliyun.com/', 'https://cashier.alipay.com/', 'https://wx.tenpay.com/']) expect(shopUrlDecision(u)).toBe('view');
    for (const u of ['https://wzyp.cn.evil.com/', 'https://evilwzyp.cn/', 'https://evil.com/', 'https://wzyp.cn:8443/']) expect(shopUrlDecision(u)).toBe('external');
    for (const u of ['http://wzyp.cn/', 'javascript:alert(1)', 'file:///tmp/x', 'data:text/html,x', 'https://user:pass@wzyp.cn/', 'mailto:a@b', 'invalid']) expect(shopUrlDecision(u)).toBe('deny');
    expect(shopUrlDecision('weixin://pay/x')).toBe('external');
    expect(shopUrlDecision('alipays://platformapi/startapp')).toBe('external');
  });
  it('window.open never creates a child or bypasses the URL policy', () => {
    const load = vi.fn(), external = vi.fn();
    const h = shopWindowOpen(load, external);
    expect(h({ url: 'https://wzyp.cn/' })).toEqual({ action: 'deny' });
    expect(load).toHaveBeenCalledWith('https://wzyp.cn/');
    h({ url: 'https://evil.com/' }); h({ url: 'weixin://pay/' }); h({ url: 'file:///secret' });
    expect(external.mock.calls).toEqual([['https://evil.com/'], ['weixin://pay/']]);
    expect(load).toHaveBeenCalledTimes(1);
  });
  it('has no preload and enforces sandbox isolation', () => {
    expect(SHOP_WEB_PREFERENCES).not.toHaveProperty('preload');
    expect(SHOP_WEB_PREFERENCES).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false });
  });
  it('denies permissions, device access and downloads', () => {
    const ses = { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), setDevicePermissionHandler: vi.fn(), on: vi.fn() };
    applySessionPolicy(ses);
    const callback = vi.fn();
    ses.setPermissionRequestHandler.mock.calls[0]![0](null, 'clipboard-read', callback);
    expect(callback).toHaveBeenCalledWith(false);
    expect(ses.setPermissionCheckHandler.mock.calls[0]![0]()).toBe(false);
    expect(ses.setDevicePermissionHandler.mock.calls[0]![0]()).toBe(false);
    const preventDefault = vi.fn(); ses.on.mock.calls[0]![1]({ preventDefault }); expect(preventDefault).toHaveBeenCalled();
  });
  it('rejects shop IPC even if its URL spoofs the app', () => {
    const frame = { url: 'app://client/', parent: null };
    expect(isTrustedSender({ sender: { mainFrame: frame }, senderFrame: frame }, { webContents: { mainFrame: frame } }, () => true)).toBe(false);
  });
  it('accepts only the minimal action schema, never URLs or bounds', () => {
    expect(isShopRequest({ action: 'show' })).toBe(true);
    for (const r of [null, [], {}, { action: 'navigate' }, { action: 'show', url: 'https://evil.com/' }, { action: 'show', bounds: {} }]) expect(isShopRequest(r)).toBe(false);
  });
});
