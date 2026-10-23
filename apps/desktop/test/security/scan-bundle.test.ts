// M7: scripts/scan-bundle.mjs flags secret shapes and weakened main/preload settings, never prints the match.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../../../scripts/scan-bundle.mjs');
let dir = '';
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
function fixture(files: Record<string, string | Buffer>, env: Record<string, string> = {}) {
  dir = mkdtempSync(join(tmpdir(), 'pa-scan-'));
  for (const [f0, c] of Object.entries(files)) { const f = f0.startsWith('/') ? f0.slice(1) : `b/${f0}`; mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), c); }
  return spawnSync(process.execPath, [SCRIPT, join(dir, 'b')], { encoding: 'utf8', env: { ...process.env, ...env } });
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
  it('random 48 without key context is not the keyword rule', () => {
    const r = fixture({ 'main/a.cjs': `const etag="${BARE}"` });
    expect(r.stderr).not.toContain('bare 48-char key ');
    expect(r.stderr).toContain('bare 48-char high-entropy string');
  });
  it('bare 48-char high-entropy string without keyword context is reported (sha256 only), allowlist suppresses it', () => {
    const r = fixture({ 'renderer/a.js': `x("${BARE}")` });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('bare 48-char high-entropy string');
    expect(r.stderr).toMatch(/sha256=[0-9a-f]{64}/);
    expect(r.stderr).not.toContain(BARE);
    const h = createHash('sha256').update(BARE).digest('hex');
    const ok = fixture({ 'renderer/a.js': `x("${BARE}")`, '/allow.json': JSON.stringify({ entries: [{ sha256: h, reason: 'test fixture' }] }) }, { PA_SCAN_ALLOWLIST: '' });
    expect(ok.status).toBe(1); // default allowlist does not contain the fixture
    const r2 = spawnSync(process.execPath, [SCRIPT, join(dir, 'b')], { encoding: 'utf8', env: { ...process.env, PA_SCAN_ALLOWLIST: join(dir, 'allow.json') } });
    expect(r2.status).toBe(0);
  });
  it('allowlist entries need a sha256 and a reason', () => {
    fixture({ 'renderer/a.js': 'ok', '/allow.json': JSON.stringify({ entries: [{ sha256: 'a'.repeat(64) }] }) });
    const r = spawnSync(process.execPath, [SCRIPT, join(dir, 'b')], { encoding: 'utf8', env: { ...process.env, PA_SCAN_ALLOWLIST: join(dir, 'allow.json') } });
    expect(r.status).not.toBe(0);
  });
  it.each([['hex', 'a3f9'.repeat(12)], ['single-case', 'abc123'.repeat(8)], ['identifier', `${'Name'.repeat(10)}12345678`]])('bare 48 %s is not reported', (_n, v) => {
    expect(fixture({ 'renderer/a.js': `x("${v}")` }).status).toBe(0);
  });
  it('the repo allowlist is well-formed and every entry is justified', () => {
    const a = JSON.parse(readFileSync(resolve(SCRIPT, '../scan-bundle-allowlist.json'), 'utf8'));
    for (const e of a.entries) { expect(e.sha256).toMatch(/^[0-9a-f]{64}$/); expect(e.reason.length).toBeGreaterThan(10); }
  });
  it('missing directory is an error, not a pass', () => {
    const r = spawnSync(process.execPath, [SCRIPT, join(tmpdir(), 'pa-scan-does-not-exist')], { encoding: 'utf8' });
    expect(r.status).toBe(2);
  });
});
