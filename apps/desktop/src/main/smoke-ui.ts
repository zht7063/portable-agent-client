import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Keyring } from '@pac/keychain';

/*
 * Dev-only M5 UI smoke (PA_SMOKE_LOGIN=1 PA_SMOKE_UI=1, LOCAL test server, throwaway account, temp HOME).
 * Drives the real pages with synthetic mouse/keyboard input: server settings (clipboard auto-clear 3s), API Keys
 * (Store to keychain ▸ Claude Code, Copy Key, Show Key, cell copy icon), Harness (Claude Code apply, command mode).
 * Main verifies keychain / clipboard / pa-key / written config by comparison only; the key is never printed.
 */
export interface UiSmokeDeps {
  tokenId: number;
  keyring: Keyring;
  helperPath: string;
  home: string;
  shotDir?: string;
  readClipboard(): string;
  clearClipboard(): void;
  revealShown(): boolean;
  click(x: number, y: number): Promise<void>;
  type(text: string): void;
  shot(file: string): Promise<Buffer>;
}

const H = `window.__pa_s = {
  vis: (el) => !!el && el.getClientRects().length > 0,
  byText: (sel, txt, root) => [...(root || document).querySelectorAll(sel)].find((e) => window.__pa_s.vis(e) && e.textContent.trim().startsWith(txt)),
  card: (title) => [...document.querySelectorAll('[data-slot=card]')].find((c) => (c.querySelector('[data-slot=card-title]')?.textContent || '').includes(title)),
  rect: (el) => { if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; },
};`;

export async function runUiSmokeStep(js: <T>(code: string) => Promise<T>, rawKey: string, d: UiSmokeDeps) {
  const secret = rawKey.startsWith('sk-') ? rawKey : `sk-${rawKey}`;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (code: string, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await js<boolean>(`(() => { ${H}; return !!(${code}); })()`)) return true; await sleep(200); }
    return false;
  };
  const clickEl = async (expr: string, what: string) => {
    if (!(await waitFor(expr))) throw new Error(`not found: ${what}`);
    const p = await js<{ x: number; y: number } | null>(`(() => { ${H}; return window.__pa_s.rect(${expr}); })()`);
    if (!p) throw new Error(`no rect: ${what}`);
    await sleep(150);
    await d.click(p.x, p.y);
    await sleep(300);
  };
  const fill = async (expr: string, text: string, what: string) => {
    if (!(await waitFor(expr))) throw new Error(`not found: ${what}`);
    await js(`(() => { ${H}; const el = ${expr}; el.focus(); el.select(); })()`);
    d.type(text);
    await sleep(200);
  };
  const go = async (path: string) => { await js(`history.pushState({}, '', ${JSON.stringify(path)}); dispatchEvent(new PopStateEvent('popstate'))`); await sleep(500); };
  const shot = async (name: string) => { if (d.shotDir) writeFileSync(join(d.shotDir, name), await d.shot(name)); };
  const steps: Record<string, unknown> = {};
  try {

  // 1. Server settings page: status + HTTP warning visible; set clipboard auto-clear to 3s through the UI.
  await go('/pa/server');
  steps.serverShown = await waitFor(`document.querySelector('[data-testid=current-server]')?.textContent.startsWith('http://127.0.0.1')`);
  steps.serverVerdict = await js<string>(`document.querySelector('[data-testid=verdict]')?.textContent || ''`);
  steps.httpWarning = await waitFor(`document.body.innerText.includes('Not using HTTPS')`, 3000);
  await fill(`document.getElementById('pa-clip-clear')`, '3', 'clip clear input');
  await clickEl(`window.__pa_s.byText('button', 'Save', document.querySelector('[data-testid=server-settings]'))`, 'save clip');
  steps.clipSaved = await waitFor(`document.body.innerText.includes('cleared from the clipboard after 3s')`, 5000);
  await shot('m5-server.png');

  // 2. API Keys page actions.
  await go('/keys');
  await waitFor(`document.querySelector('[data-testid=pa-masked-key]')`, 20000);
  steps.upstreamPopoverAbsent = await js<boolean>(`!document.querySelector('[data-testid=pa-masked-key]')?.closest('td')?.querySelector('[data-slot=popover-trigger]')`);
  const openMenu = () => clickEl(`[...document.querySelectorAll('button[aria-label="Open menu"]')].find(window.__pa_s.vis)`, 'row menu');
  await openMenu();
  steps.upstreamCopyItemsHidden = await js<boolean>(`(() => { const t = [...document.querySelectorAll('[role=menuitem]')].map((e) => e.textContent); return !t.some((x) => /Copy Connection Info|CC Switch/.test(x)); })()`);
  await clickEl(`window.__pa_s.byText('[role=menuitem]', 'Store to keychain')`, 'store submenu');
  await clickEl(`window.__pa_s.byText('[role=menuitem]', 'Claude Code')`, 'store claude');
  steps.storeToast = await waitFor(`document.body.innerText.includes('in the keychain for Claude Code')`, 8000);
  try { steps.keychainMatches = (await d.keyring.get('default/claude')) === secret; } catch (e) { steps.keychainMatches = `lookup error: ${String(e).slice(0, 80)}`; }

  d.clearClipboard();
  await openMenu();
  await clickEl(`window.__pa_s.byText('[role=menuitem]', 'Copy Key')`, 'copy key');
  await waitFor(`document.body.innerText.includes('clipboard is cleared in 3s')`, 5000);
  steps.menuCopyClipboardMatches = d.readClipboard() === secret;
  await sleep(4000);
  steps.clipboardAutoCleared = d.readClipboard() === '';

  d.clearClipboard();
  await clickEl(`[...document.querySelectorAll('button[aria-label="Copy API key"]')].find(window.__pa_s.vis)`, 'cell copy');
  await sleep(800);
  steps.cellCopyClipboardMatches = d.readClipboard() === secret;
  d.clearClipboard();

  await openMenu();
  await clickEl(`window.__pa_s.byText('[role=menuitem]', 'Show Key')`, 'show key');
  await sleep(500);
  steps.showKeyNativeBox = d.revealShown();
  await openMenu();
  await clickEl(`window.__pa_s.byText('[role=menuitem]', 'Store to keychain')`, 'store submenu (shot)');
  await sleep(400);
  await shot('m5-tokens.png');
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await go('/dashboard/overview'); await sleep(300);

  // 3. Harness page: Claude Code, command key mode, typed model, preview -> apply -> confirm.
  await go('/pa/harness');
  await waitFor(`window.__pa_s.card('Claude Code')?.innerText.includes('Preview changes')`, 15000);
  await sleep(1000);
  const cc = `window.__pa_s.card('Claude Code')`;
  await js(`(() => { ${H}; const s = ${cc}.querySelector('#claude-mode'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, 'command'); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const modelIsInput = await js<boolean>(`(() => { ${H}; return ${cc}.querySelector('#claude-main')?.tagName === 'INPUT'; })()`);
  if (modelIsInput) await fill(`${cc}.querySelector('#claude-main')`, 'smoke-model', 'model input');
  await clickEl(`window.__pa_s.byText('button', 'Preview changes', ${cc})`, 'preview');
  steps.previewShown = await waitFor(`${cc}.querySelector('[aria-label="Change preview"]')`, 10000);
  steps.previewHasKey = await js<boolean>(`document.body.innerHTML.includes(${JSON.stringify(secret)})`);
  await clickEl(`window.__pa_s.byText('button', 'Apply', ${cc})`, 'apply');
  await clickEl(`window.__pa_s.byText('[role=alertdialog] button, [role=dialog] button', 'Confirm')`, 'confirm');
  steps.applied = await waitFor(`${cc}.innerText.includes('Written')`, 10000);
  await sleep(500);
  await shot('m5-harness.png');

  let settings = '';
  try { settings = readFileSync(join(d.home, '.claude', 'settings.json'), 'utf8'); } catch { /* not written */ }
  let paKeyMatches = false;
  try { paKeyMatches = execFileSync(d.helperPath, ['default', 'claude'], { encoding: 'utf8', env: process.env }) === secret; } catch { paKeyMatches = false; }
  steps.paKeyMatches = paKeyMatches;
  steps.claudeConfigUsesHelper = settings.includes('apiKeyHelper') && settings.includes(d.helperPath);
  steps.claudeConfigHasKey = settings.includes(secret);
  d.clearClipboard();

  } catch (e) {
    steps.error = String(e).slice(0, 200);
    steps.page = (await js<string>(`document.body.innerText.slice(0, 400)`)).replace(/sk-[A-Za-z0-9]{20,}/g, '[full-key!]');
  }
  const must = ['serverShown', 'httpWarning', 'clipSaved', 'upstreamPopoverAbsent', 'upstreamCopyItemsHidden', 'storeToast', 'keychainMatches',
    'menuCopyClipboardMatches', 'clipboardAutoCleared', 'cellCopyClipboardMatches', 'showKeyNativeBox', 'previewShown', 'applied', 'paKeyMatches', 'claudeConfigUsesHelper'];
  const ok = must.every((k) => steps[k] === true) && steps.previewHasKey === false && steps.claudeConfigHasKey === false;
  const haystack = await js<string>(`document.documentElement.outerHTML`);
  return { result: steps, ok, haystack };
}
