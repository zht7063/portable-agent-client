/**
 * Aegis M6 item 5: hardening that depends on app.isPackaged. Pure (no electron import) so it is unit-tested.
 *  - packaged: no View menu (no reload / force-reload / toggleDevTools / zoom roles) and devTools: false.
 *  - unpackaged (dev): standard View menu and DevTools stay available.
 */
import type { MenuItemConstructorOptions, WebPreferences } from 'electron';
import { SECURE_WEB_PREFERENCES } from './security-policy';

export function windowWebPreferences(o: { preload: string; isPackaged: boolean }): WebPreferences {
  return {
    preload: o.preload,
    ...SECURE_WEB_PREFERENCES,
    devTools: !o.isPackaged,
  };
}

export function menuTemplate(o: { isPackaged: boolean; platform: string; about: MenuItemConstructorOptions }): MenuItemConstructorOptions[] {
  return [
    ...(o.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' }, { role: 'editMenu' },
    ...(o.isPackaged ? [] : [{ role: 'viewMenu' as const }]),
    { role: 'windowMenu' },
    { role: 'help', submenu: [o.about] },
  ];
}
