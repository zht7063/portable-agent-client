/* global process, console */
// Stages a dependency-free app dir for electron-builder (local packaging only; never publishes).
// Everything is pre-bundled by esbuild into dist/. The only runtime module is @napi-rs/keyring, staged for
// macOS/Windows targets only; @napi-rs/keyring-linux-* is never shipped (bundles libdbus, AFL-2.1 OR GPL-2.0+) —
// Linux uses secret-tool (libsecret-tools) or env mode.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, '..');
const stage = join(app, 'stage');
const platform = process.env.PA_TARGET_PLATFORM ?? process.platform;
const arch = process.env.PA_TARGET_ARCH ?? process.arch;
const pkg = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
const product = JSON.parse(readFileSync(join(app, '..', '..', 'packages', 'core', 'src', 'product.config.json'), 'utf8'));
const repo = join(app, '..', '..');

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const d of ['main', 'preload', 'key-helper', 'renderer']) {
  if (!existsSync(join(app, 'dist', d))) throw new Error(`dist/${d} missing; run bun run build first`);
  cpSync(join(app, 'dist', d), join(stage, 'dist', d), { recursive: true });
}
// Window icon (Windows/Linux BrowserWindow, loaded from dist/icon.png by dist/main/index.cjs); must be packaged.
if (!existsSync(join(app, 'dist', 'icon.png'))) throw new Error('dist/icon.png missing; run bun run build first');
cpSync(join(app, 'dist', 'icon.png'), join(stage, 'dist', 'icon.png'));
if (!existsSync(join(stage, 'dist', 'icon.png'))) throw new Error('stage: dist/icon.png was not staged');
writeFileSync(join(stage, 'package.json'), JSON.stringify({
  name: product.executableName, productName: product.productName, version: pkg.version === '0.0.0' ? '0.0.1' : pkg.version,
  description: `${product.productName} desktop client (based on new-api)`, author: product.productName, homepage: product.sourceUrl ?? product.upstream.repo, license: 'AGPL-3.0-only', main: 'dist/main/index.cjs',
}, null, 2));
// AGPL-3.0: license materials travel with every package.
for (const f of ['LICENSE', 'NOTICE', 'THIRD-PARTY-LICENSES.md']) cpSync(join(repo, f), join(stage, f));

const staged = [];
const stagedVersions = {};
if (platform === 'darwin' || platform === 'win32') {
  // bun's isolated linker exposes @napi-rs/keyring only to its dependent (@pac/keychain), and the platform binary
  // only next to @napi-rs/keyring itself, so resolve from there.
  const keychainReq = createRequire(join(repo, 'packages', 'keychain', 'package.json'));
  const copy = (name, req = keychainReq) => {
    const src = dirname(req.resolve(`${name}/package.json`));
    const lic = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8')).license;
    if (lic !== 'MIT') throw new Error(`${name}: unexpected license ${lic}`);
    cpSync(src, join(stage, 'node_modules', ...name.split('/')), { recursive: true });
    staged.push(name);
    stagedVersions[name] = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8')).version;
  };
  copy('@napi-rs/keyring');
  const keyringReq = createRequire(keychainReq.resolve('@napi-rs/keyring/package.json'));
  // Cross-builds: bun installs only the host's optional platform binary. PA_NATIVE_PREBUILT_DIR may point at a dir
  // with node_modules/@napi-rs/keyring-<plat>/ fetched separately (e.g. `npm pack`), same version, MIT-checked.
  const prebuiltReq = process.env.PA_NATIVE_PREBUILT_DIR ? createRequire(join(process.env.PA_NATIVE_PREBUILT_DIR, 'package.json')) : null;
  // One arch per stage (pack:mac stages and packages arm64 and x64 separately), so the generated package.json
  // declares exactly the binary that is bundled.
  if (!/^(x64|arm64|ia32|armv7l)$/.test(arch)) throw new Error(`PA_TARGET_ARCH must be a single arch (got ${arch})`);
  for (const a of [arch]) {
    const plat = { darwin: `darwin-${a}`, win32: `win32-${a}-msvc` }[platform];
    try { copy(`@napi-rs/keyring-${plat}`, keyringReq); } catch (e) {
      try { if (!prebuiltReq) throw e; copy(`@napi-rs/keyring-${plat}`, prebuiltReq); } catch (e2) { console.warn(`warning: @napi-rs/keyring-${plat} not installed (${e2.message}); keychain will fall back to env mode`); }
    }
  }
}
// electron-builder only packs node_modules that the app package.json declares; without this the native keyring
// module was silently dropped from mac/win packages (keychain fell back to env mode).
if (staged.length) {
  const sp = join(stage, 'package.json');
  writeFileSync(sp, JSON.stringify({ ...JSON.parse(readFileSync(sp, 'utf8')), dependencies: stagedVersions }, null, 2));
}
console.log(`staged ${platform}-${arch}: native modules [${staged.join(', ') || 'none'}]`);
