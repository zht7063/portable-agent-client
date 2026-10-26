/* global process, console */
// Stages a dependency-free app dir for electron-builder (local packaging only; never publishes).
// Main and preload are prebundled; harness keys use files and need no native keyring modules.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
for (const d of ['main', 'preload', 'renderer']) {
  if (!existsSync(join(app, 'dist', d))) throw new Error(`dist/${d} missing; run bun run build first`);
  cpSync(join(app, 'dist', d), join(stage, 'dist', d), { recursive: true });
}
// Window icon (Windows/Linux BrowserWindow, loaded from dist/icon.png by dist/main/index.cjs); must be packaged.
if (!existsSync(join(app, 'dist', 'icon.png'))) throw new Error('dist/icon.png missing; run bun run build first');
cpSync(join(app, 'dist', 'metafile.json'), join(stage, 'dist', 'metafile.json'));
cpSync(join(app, 'dist', 'icon.png'), join(stage, 'dist', 'icon.png'));
if (!existsSync(join(stage, 'dist', 'icon.png'))) throw new Error('stage: dist/icon.png was not staged');
writeFileSync(join(stage, 'package.json'), JSON.stringify({
  name: product.executableName, productName: product.productName, version: pkg.version === '0.0.0' ? '0.0.1' : pkg.version,
  description: `${product.productName} desktop client (based on new-api)`, author: product.productName, homepage: product.sourceUrl ?? product.upstream.repo, license: 'AGPL-3.0-only', main: 'dist/main/index.cjs',
}, null, 2));
// AGPL-3.0: license materials travel with every package.
for (const f of ['LICENSE', 'NOTICE', 'THIRD-PARTY-LICENSES.md']) cpSync(join(repo, f), join(stage, f));

console.log(`staged ${platform}-${arch}: dependency-free production app`);
