import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { SHOP_LINK_GESTURE_SETUP, shopTakeLinkGesture } from '../../src/main/shop-gesture';

describe('main-document popup link authorization', () => {
  it('requires a trusted top-document link click, matches URL, expires and consumes once', () => {
    const listeners = new Map<string, (event: unknown) => void>();
    let now = 0;
    class Anchor { constructor(public href: string) {} }
    const context = { document: { addEventListener: (name: string, callback: (event: unknown) => void) => listeners.set(name, callback) }, HTMLAnchorElement: Anchor, performance: { now: () => now } };
    runInNewContext(SHOP_LINK_GESTURE_SETUP, context);
    const take = (url = 'https://evil.com/') => runInNewContext(shopTakeLinkGesture(url), context);
    const click = (trusted: boolean, target: unknown = new Anchor('https://evil.com/')) => listeners.get('click')!({ isTrusted: trusted, composedPath: () => [target] });
    expect(take()).toBe(false);
    click(false); expect(take()).toBe(false);
    click(true, {}); expect(take()).toBe(false);
    click(true); expect(take('https://other.com/')).toBe(false); expect(take()).toBe(false);
    click(true); expect(take()).toBe(true); expect(take()).toBe(false);
    click(true); now = 1000; expect(take()).toBe(false);
  });
});
