// M7: scripts/scan-bundle.mjs flags secret shapes and weakened main/preload settings, never prints the match.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../../../scripts/scan-bundle.mjs');
let dir = '';
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
function fixture(files: Record<string, string | Buffer>) {
  dir = mkdtempSync(join(tmpdir(), 'pa-scan-'));
  for (const [f, c] of Object.entries(files)) { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), c); }
  return spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });
}
const KEY = 'sk-' + 'Ab1'.repeat(16);
const BARE = 'Qx7'.repeat(16); // synthetic 48-char mixed-case "key"
/** Builds a minimal asar archive (pickle header + JSON index + concatenated file data). */
function asar(files: Record<string, string>): Buffer {
  const root: { files: Record<string, unknown> } = { files: {} };
  const datas: Buffer[] = [];
  let offset = 0;
  for (const [p, c] of Object.entries(files)) {
    const parts = p.split('/');
    let node = root;
    for (const d of parts.slice(0, -1)) node = ((node.files[d] ??= { files: {} }) as typeof root);
    const b = Buffer.from(c);
    node.files[parts.at(-1)!] = { size: b.length, offset: String(offset) };
    offset += b.length;
    datas.push(b);
  }
  const json = Buffer.from(JSON.stringify(root));
  const padded = Math.ceil(json.length / 4) * 4;
  const header = Buffer.alloc(16 + padded);
  header.writeUInt32LE(4, 0); header.writeUInt32LE(8 + padded, 4); header.writeUInt32LE(4 + padded, 8); header.writeInt32LE(json.length, 12);
  json.copy(header, 16);
  return Buffer.concat([header, ...datas]);
}

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
  it.each([
    ['main/a.cjs', `const cfg={apiKey:"${BARE}"}`],
    ['renderer/notes.txt', `token = '${BARE}'`],
    ['renderer/logo.svg', `<svg data-key="${BARE}"/>`.replace('data-key="', 'key="')],
  ])('unprefixed 48-char key in key-like context: %s', (f, content) => {
    const r = fixture({ [f]: content });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('bare 48-char key');
    expect(r.stderr).not.toContain(BARE);
  });
  it.each([
    ['48-hex hash as key', `const o={key:"${'a3f9'.repeat(12)}"}`],
    ['lowercase id as token', `token: "${'abc123'.repeat(8)}"`],
    ['random 48 not in key context', `const etag="${BARE}"`],
    ['49 chars', `apiKey="${BARE}Z"`],
  ])('no false positive: %s', (_n, content) => {
    const r = fixture({ 'main/a.cjs': content });
    expect(r.status).toBe(0);
  });
  it('scans release/ trees and files inside .asar archives (unprefixed key and main-only rules)', () => {
    const r = fixture({
      'release/linux-unpacked/resources/app.asar': asar({ 'dist/main/index.cjs': 'w.webContents.openDevTools()', 'dist/renderer/a.js': `apiKey:"${BARE}"`, 'node_modules/x/i.js': 'openDevTools()' }),
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/app\.asar:dist\/main\/index\.cjs/);
    expect(r.stderr).toContain('openDevTools');
    expect(r.stderr).toMatch(/app\.asar:dist\/renderer\/a\.js.*|bare 48-char key/);
    expect(r.stderr).not.toContain('node_modules/x');
    expect(r.stderr).not.toContain(BARE);
  });
  it('clean .asar passes; corrupt .asar fails', () => {
    expect(fixture({ 'app.asar': asar({ 'main/i.cjs': 'ok()' }) }).status).toBe(0);
    rmSync(dir, { recursive: true, force: true });
    const r = fixture({ 'app.asar': 'not an archive' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('unreadable asar');
  });
  it('missing directory is an error, not a pass', () => {
    const r = spawnSync(process.execPath, [SCRIPT, join(tmpdir(), 'pa-scan-does-not-exist')], { encoding: 'utf8' });
    expect(r.status).toBe(2);
  });
});
