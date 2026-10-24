/* global process, console, setTimeout, clearTimeout */
// Smoke test for the local unpacked production build (release/linux-unpacked). Temp HOME; no network writes.
// Production builds contain no smoke hooks (PA_SMOKE is compiled out), so this only observes the app from outside:
//   boots and loads the renderer ("[pac] renderer loaded" on stdout), pa-key wrapper installed in userData/bin and
//   runnable, no smoke markers in the packaged JS, license files present, no @napi-rs/keyring-linux binaries.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = process.argv[2] ?? join(app, 'release', 'linux-unpacked');
const product = JSON.parse(readFileSync(join(app, '..', '..', 'packages', 'core', 'src', 'product.config.json'), 'utf8'));
const exe = join(dir, product.executableName);
if (!existsSync(exe)) { console.log(`no packaged app at ${exe}; run bun run pack:dir`); process.exit(1); }
const root = mkdtempSync(join(tmpdir(), 'pa-pack-smoke-'));
const userData = join(root, '.config', product.productName);
const args = [];
if (process.env.PA_SMOKE_NO_SANDBOX === '1' || process.getuid?.() === 0) args.push('--no-sandbox');
const env = { PATH: process.env.PATH ?? '', DISPLAY: process.env.DISPLAY ?? '', XAUTHORITY: process.env.XAUTHORITY ?? '', HOME: root, XDG_CONFIG_HOME: join(root, '.config'), PAC_SERVER_URL: process.env.PAC_SERVER_URL ?? 'http://127.0.0.1:9' };

const boot = await new Promise((resolve) => {
  const p = spawn(exe, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const done = (ok) => { clearTimeout(t); p.kill('SIGTERM'); resolve(ok); };
  const t = setTimeout(() => done(false), 60000);
  p.stdout.on('data', (b) => { out += b; if (out.includes('[pac] renderer loaded')) setTimeout(() => done(true), 1500); });
  p.on('exit', () => { clearTimeout(t); resolve(out.includes('[pac] renderer loaded')); });
});
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? [p, ...walk(p)] : [p]; });
const res = join(dir, 'resources');
const files = walk(res);
const asar = readFileSync(join(res, 'app.asar'));
const jsUnpacked = files.filter((f) => f.endsWith('.cjs') || f.endsWith('.js')).map((f) => readFileSync(f));
const smokeMarkers = ['PA_SMOKE', 'runLoginSmoke', 'runUiSmokeStep', 'runKeysSmokeStep'];
const wrapper = join(userData, 'bin', 'pa-key');
const licenseFiles = ['LICENSE', 'NOTICE', 'THIRD-PARTY-LICENSES.md'];
const licenseResources = ['LICENSE.txt', 'NOTICE.txt', 'THIRD-PARTY-LICENSES.txt', 'LICENSE.new-api.txt', 'NOTICE.new-api.txt', 'fontsource-variable_lora.LICENSE.txt', 'fontsource-variable_public-sans.LICENSE.txt'];
const out = {
  boot, wrapper: existsSync(wrapper), wrapperMode: existsSync(wrapper) ? (statSync(wrapper).mode & 0o777).toString(8) : null,
  scriptUnpacked: existsSync(join(res, 'app.asar.unpacked', 'dist', 'key-helper', 'pa-key.cjs')),
  keyringLinuxShipped: files.some((f) => /keyring-linux/.test(f)) || asar.includes('keyring-linux-x64'),
  smokeCode: smokeMarkers.filter((m) => asar.includes(m) || jsUnpacked.some((b) => b.includes(m))),
  licenses: Object.fromEntries([...licenseFiles.map((f) => [f, asar.includes(`"${f}"`)]), ...licenseResources.map((f) => [`resources/licenses/${f}`, existsSync(join(res, 'licenses', f))])]),
  helper: null,
};
if (out.wrapper) {
  // No keychain entry exists in this temp HOME: expect a clean non-zero exit with empty stdout (proves the wrapper runs pa-key.cjs).
  const h = spawnSync(wrapper, ['default', 'codex'], { env: { PATH: env.PATH, HOME: root }, encoding: 'utf8', timeout: 20000 });
  out.helper = { code: h.status, stdoutEmpty: h.stdout === '', stderr: (h.stderr ?? '').trim().split('\n')[0]?.slice(0, 160) };
}
rmSync(root, { recursive: true, force: true });
console.log(`PA_PACK_SMOKE ${JSON.stringify(out)}`);
const ok = out.boot && out.wrapper && out.scriptUnpacked && !out.keyringLinuxShipped && out.smokeCode.length === 0
  && Object.values(out.licenses).every(Boolean) && out.helper && out.helper.code !== 0 && out.helper.code !== null && out.helper.stdoutEmpty;
process.exit(ok ? 0 : 1);
