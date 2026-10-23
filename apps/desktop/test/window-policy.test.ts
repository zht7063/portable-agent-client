// Aegis M6 item 5: packaged app has no View menu / reload / toggleDevTools and devTools:false.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { menuTemplate, windowWebPreferences } from '../src/main/window-policy';

const about = { label: 'About & licenses' };
const roles = (t: ReturnType<typeof menuTemplate>): string[] =>
  t.flatMap((i) => [String(i.role ?? ''), ...(Array.isArray(i.submenu) ? i.submenu.map((s) => String(s.role ?? '')) : [])]);
const FORBIDDEN = ['viewMenu', 'reload', 'forceReload', 'toggleDevTools'];

describe('window policy', () => {
  for (const platform of ['linux', 'win32', 'darwin']) {
    it(`packaged (${platform}): no viewMenu/reload/toggleDevTools`, () => {
      const r = roles(menuTemplate({ isPackaged: true, platform, about }));
      for (const f of FORBIDDEN) expect(r).not.toContain(f);
      expect(r).toContain('help');
    });
  }
  it('dev build keeps the View menu', () => {
    expect(roles(menuTemplate({ isPackaged: false, platform: 'linux', about }))).toContain('viewMenu');
  });
  it('devTools false when packaged, true in dev; other hardening unchanged', () => {
    const p = windowWebPreferences({ preload: '/x', isPackaged: true });
    expect(p.devTools).toBe(false);
    expect(windowWebPreferences({ preload: '/x', isPackaged: false }).devTools).toBe(true);
    expect(p).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, webviewTag: false });
  });
  it('index.ts uses the policy (no inline viewMenu / webPreferences literal)', () => {
    const src = readFileSync(join(__dirname, '../src/main/index.ts'), 'utf8');
    expect(src).toContain('windowWebPreferences({');
    expect(src).toContain('menuTemplate({ isPackaged: app.isPackaged');
    expect(src).not.toMatch(/role:\s*'viewMenu'|toggleDevTools|openDevTools/);
  });
});
