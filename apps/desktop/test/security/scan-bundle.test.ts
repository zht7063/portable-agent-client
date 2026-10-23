// M7: scripts/scan-bundle.mjs flags secret shapes and weakened main/preload settings, never prints the match.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../../../scripts/scan-bundle.mjs');
let dir = '';
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
function fixture(files: Record<string, string>) {
  dir = mkdtempSync(join(tmpdir(), 'pa-scan-'));
  for (const [f, c] of Object.entries(files)) { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), c); }
  return spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });
}
const KEY = 'sk-' + 'Ab1'.repeat(16);

describe('scan-bundle', () => {
  it('clean bundle passes (bridge built from ipcRenderer is fine; renderer may say token)', () => {
    const r = fixture({
      'preload/index.cjs': 'exposeInMainWorld("pa", createBridge(import_electron.ipcRenderer))',
      'main/index.cjs': 'new BrowserWindow({webPreferences:{contextIsolation:!0,sandbox:!0,nodeIntegration:!1}})',
      'renderer/assets/a.js': 'const token = localStorage.getItem("token"); x.nodeIntegration = true',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('scan-bundle: clean');
  });
  it.each([
    ['renderer/a.js', `const k="${KEY}"`, 'sk- API key'],
    ['main/a.cjs', 'Authorization: "Bearer ' + 'x'.repeat(40) + '"', 'Bearer literal'],
    ['main/a.cjs', '-----BEGIN PRIVATE KEY-----', 'private key'],
    ['main/a.cjs', 'webPreferences:{nodeIntegration:!0}', 'nodeIntegration: true'],
    ['main/a.cjs', 'webPreferences:{sandbox:false}', 'sandbox: false'],
    ['main/a.cjs', 'w.webContents.openDevTools()', 'openDevTools'],
    ['preload/i.cjs', 'contextBridge.exposeInMainWorld("x", electron.ipcRenderer)', 'raw ipcRenderer exposed'],
  ])('%s with %s -> %s', (f, content, rule) => {
    const r = fixture({ [f]: content });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(rule);
    expect(r.stderr).not.toContain(KEY);
    expect(r.stderr).not.toContain('x'.repeat(40));
  });
  it('missing directory is an error, not a pass', () => {
    const r = spawnSync(process.execPath, [SCRIPT, join(tmpdir(), 'pa-scan-does-not-exist')], { encoding: 'utf8' });
    expect(r.status).toBe(2);
  });
});
