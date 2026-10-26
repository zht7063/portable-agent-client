// Runs only in the main document's isolated world. No preload or IPC bridge.
// Bind authorization to the actual trusted link target, not propagated frame activation.
export const SHOP_LINK_GESTURE_SETUP = `(() => {
  let link;
  globalThis.__shopTakeLink = url => {
    const current = link;
    link = undefined;
    return !!current && performance.now() - current.time < 1000 && current.url === url;
  };
  const remember = event => {
    link = undefined;
    if (!event.isTrusted) return;
    const anchor = event.composedPath().find(node => node instanceof HTMLAnchorElement);
    if (anchor) link = { url: anchor.href, time: performance.now() };
  };
  document.addEventListener('click', remember, true);
  document.addEventListener('auxclick', remember, true);
})()`;

export function shopTakeLinkGesture(url: string): string {
  return `globalThis.__shopTakeLink?.(${JSON.stringify(url)}) === true`;
}
