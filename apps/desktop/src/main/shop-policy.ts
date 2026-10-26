import { SECURE_WEB_PREFERENCES } from './security-policy';

export const SHOP_URL = 'https://wzyp.cn/shop/IZQQ51WQ';
export const SHOP_PARTITION = 'persist:shop';
export const SHOP_WEB_PREFERENCES = Object.freeze({ ...SECURE_WEB_PREFERENCES });
// TODO: verify captcha and cashier navigation hosts on a real network before expanding this list.
export const SHOP_HOSTS = ['wzyp.cn', 'captcha.aliyun.com', 'captcha.alicdn.com', 'cf.aliyun.com', 'icheck.alibaba.com', 'cashier.alipay.com', 'mapi.alipay.com', 'openapi.alipay.com', 'wx.tenpay.com', 'pay.weixin.qq.com'] as const;
export function shopUrlDecision(raw: string): 'view' | 'external' | 'deny' {
  try {
    const u = new URL(raw);
    if (u.username || u.password || raw.length > 8192) return 'deny';
    if (u.protocol === 'weixin:' || u.protocol === 'alipays:') return raw.startsWith(`${u.protocol}//`) ? 'external' : 'deny';
    if (u.protocol !== 'https:') return 'deny';
    if (u.port && u.port !== '443') return 'external';
    return SHOP_HOSTS.some(h => u.hostname === h || (h === 'wzyp.cn' && u.hostname.endsWith('.wzyp.cn'))) ? 'view' : 'external';
  } catch { return 'deny'; }
}
export function shopWindowOpen(load: (url: string) => void, external: (url: string) => void) {
  return ({ url }: { url: string }): { action: 'deny' } => {
    const decision = shopUrlDecision(url);
    if (decision === 'view') load(url);
    if (decision === 'external') external(url);
    return { action: 'deny' };
  };
}
export const SHOP_ACTIONS = ['show', 'hide', 'reload', 'open-in-browser', 'clear-data'] as const;
export type ShopAction = typeof SHOP_ACTIONS[number];
export function isShopRequest(r: unknown): r is { action: ShopAction } {
  return !!r && typeof r === 'object' && !Array.isArray(r) && Object.keys(r).length === 1 && SHOP_ACTIONS.includes((r as { action: ShopAction }).action);
}
