// M7: scripts/scan-bundle.mjs flags secret shapes and weakened main/preload settings, never prints the match.
import { spawnSync } from '../../../../test/helpers/subprocess';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../../../scripts/scan-bundle.mjs');
let dir = '';
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
const NOCI = () => { const e = { ...process.env }; delete e.CI; delete e.GITHUB_ACTIONS; return e; };
const run = (env: Record<string, string> = {}) => spawnSync(process.execPath, [SCRIPT, join(dir, 'b')], { encoding: 'utf8', env: { ...NOCI(), ...env } });
function fixture(files: Record<string, string | Buffer>, env: Record<string, string> = {}) {
  dir = mkdtempSync(join(tmpdir(), 'pa-scan-'));
  for (const [f0, c] of Object.entries(files)) { const f = f0.startsWith('/') ? f0.slice(1) : `b/${f0}`; mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), c); }
  return run(env);
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
    const allow = (paths: string[]) => JSON.stringify({ entries: [{ sha256: h, paths, reason: 'test fixture' }] });
    const A = { PA_SCAN_ALLOWLIST: join(dir, 'allow.json') };
    writeFileSync(join(dir, 'allow.json'), allow(['renderer/*.js']));
    expect(run(A).status).toBe(0); // hash + path match
    writeFileSync(join(dir, 'allow.json'), allow(['renderer/other.js']));
    expect(run(A).status).toBe(1); // same hash, other path: still reported
  });
  it('allowlist: hash in a non-listed file is reported; asar-internal path form matches', () => {
    const h = createHash('sha256').update(BARE).digest('hex');
    fixture({ 'renderer/a.js': `x("${BARE}")`, 'main/b.cjs': `y("${BARE}")`, 'rel/resources/app.asar': asar({ 'dist/renderer/c.js': `z("${BARE}")` }),
      '/allow.json': JSON.stringify({ entries: [{ sha256: h, paths: ['renderer/a.js', '**/resources/app.asar:dist/renderer/*.js'], reason: 'test fixture' }] }) });
    const r = run({ PA_SCAN_ALLOWLIST: join(dir, 'allow.json') });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('main/b.cjs');
    expect(r.stderr).not.toContain('renderer/a.js');
    expect(r.stderr).not.toContain('app.asar:');
  });
  it('shipped allowlist: SVG chunk entry stays sha256-pinned and its globs cover linux/win and both mac .app layouts', async () => {
    const { globToRegExp } = await import(SCRIPT) as { globToRegExp: (g: string) => RegExp };
    const al = JSON.parse(readFileSync(resolve(SCRIPT, '../scan-bundle-allowlist.json'), 'utf8')) as { entries: { sha256: string; paths: string[] }[] };
    expect(al.entries).toHaveLength(1);
    const e = al.entries[0]!;
    expect(e.sha256).toMatch(/^[0-9a-f]{64}$/);
    const ok = (p: string) => e.paths.some((g) => globToRegExp(g).test(p));
    const inner = 'app.asar:dist/renderer/static/js/async/24151.abc123.js';
    for (const p of ['renderer/static/js/async/24151.abc123.js', `linux-unpacked/resources/${inner}`, `win-unpacked/resources/${inner}`,
      `mac-arm64/Portable Agent.app/Contents/Resources/${inner}`, `mac/Portable Agent.app/Contents/Resources/${inner}`]) expect(ok(p), p).toBe(true);
    for (const p of [`mac/Portable Agent.app/Contents/Resources/app.asar:dist/renderer/static/js/async/99999.abc.js`, 'renderer/static/js/other.js',
      `mac/Portable Agent.app/Contents/Resources/app.asar:dist/main/24151.abc.js`]) expect(ok(p), p).toBe(false);
  });
  it('mac .app asar layout (arm64 + x64) is scanned and the allowlist form matches it', () => {
    const h = createHash('sha256').update(BARE).digest('hex');
    const app = (d: string) => `${d}/Portable Agent.app/Contents/Resources/app.asar`;
    fixture({ [app('mac-arm64')]: asar({ 'dist/renderer/c.js': `z("${BARE}")` }), [app('mac')]: asar({ 'dist/renderer/c.js': `z("${BARE}")` }),
      '/allow.json': JSON.stringify({ entries: [{ sha256: h, paths: ['**/Contents/Resources/app.asar:dist/renderer/*.js'], reason: 'test fixture' }] }) });
    expect(run({ PA_SCAN_ALLOWLIST: join(dir, 'allow.json') }).status).toBe(0);
    const r = run(); // default allowlist does not cover this fixture hash: both mac asars are reported
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('mac-arm64/');
    expect(r.stderr).toContain('mac/Portable Agent.app');
  });
  it.each([['CI', 'true'], ['CI', 'TRUE'], ['CI', '1'], ['GITHUB_ACTIONS', 'true'], ['GITHUB_ACTIONS', 'True'], ['GITHUB_ACTIONS', '1']])('PA_SCAN_ALLOWLIST override is refused when %s=%s', (k, v) => {
    fixture({ 'renderer/a.js': 'ok', '/allow.json': JSON.stringify({ entries: [] }) });
    const r = run({ PA_SCAN_ALLOWLIST: join(dir, 'allow.json'), [k]: v });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('refused in CI');
  });
  it.each([['CI', 'false'], ['CI', '0'], ['CI', '']])('override allowed locally when %s=%s', (k, v) => {
    fixture({ 'renderer/a.js': 'ok', '/allow.json': JSON.stringify({ entries: [] }) });
    expect(run({ PA_SCAN_ALLOWLIST: join(dir, 'allow.json'), [k]: v }).status).toBe(0);
  });
  it('allowlist entries need sha256, paths and a reason', () => {
    for (const e of [{ sha256: 'a'.repeat(64), paths: ['x'] }, { sha256: 'a'.repeat(64), reason: 'no paths here' }]) {
      fixture({ 'renderer/a.js': 'ok', '/allow.json': JSON.stringify({ entries: [e] }) });
      expect(run({ PA_SCAN_ALLOWLIST: join(dir, 'allow.json') }).status).toBe(2);
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it.each([['hex', 'a3f9'.repeat(12)], ['single-case', 'abc123'.repeat(8)], ['identifier', `${'Name'.repeat(10)}12345678`]])('bare 48 %s is not reported', (_n, v) => {
    expect(fixture({ 'renderer/a.js': `x("${v}")` }).status).toBe(0);
  });
  it('the repo allowlist is well-formed and every entry is justified', () => {
    const a = JSON.parse(readFileSync(resolve(SCRIPT, '../scan-bundle-allowlist.json'), 'utf8'));
    for (const e of a.entries) { expect(e.sha256).toMatch(/^[0-9a-f]{64}$/); expect(e.reason.length).toBeGreaterThan(10); expect(e.paths.length).toBeGreaterThan(0); }
  });
  it('symlinks are skipped, not followed (no loops, nothing outside the scanned dir)', () => {
    dir = mkdtempSync(join(tmpdir(), 'pa-scan-'));
    mkdirSync(join(dir, 'b', 'Versions', 'A'), { recursive: true });
    writeFileSync(join(dir, 'b', 'Versions', 'A', 'ok.js'), 'x()');
    writeFileSync(join(dir, 'outside.js'), `const k = "${KEY}";`);
    symlinkSync(join(dir, 'b'), join(dir, 'b', 'Versions', 'loop'));
    symlinkSync('A', join(dir, 'b', 'Versions', 'Current'));
    symlinkSync(join(dir, 'outside.js'), join(dir, 'b', 'linked.js'));
    const r = run();
    expect(r.status).toBe(0);
    writeFileSync(join(dir, 'b', 'Versions', 'A', 'bad.js'), `const k = "${KEY}";`);
    expect(run().status).not.toBe(0); // real files are still scanned
  });
  it('missing directory is an error, not a pass', () => {
    const r = spawnSync(process.execPath, [SCRIPT, join(tmpdir(), 'pa-scan-does-not-exist')], { encoding: 'utf8' });
    expect(r.status).toBe(2);
  });
});
