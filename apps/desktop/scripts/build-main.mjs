/* global process, console */
// Bundles main, preload and the pa-key helper with esbuild.
//   node scripts/build-main.mjs          -> dev/test build: smoke hooks compiled in (PA_SMOKE=1 activates them)
//   node scripts/build-main.mjs --prod   -> production build: __PA_SMOKE__=false, smoke code folded away and
//                                           tree-shaken; the build fails if any smoke marker survives.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const prod = process.argv.includes('--prod') || process.env.PA_BUILD === 'production';
const out = process.env.PA_OUT_DIR ?? join(app, 'dist'); // tests build into a temp dir
const git = (...a) => { try { return execFileSync('git', a, { cwd: app, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
// PA_BUILD_COMMIT may name the commit, but never hides a dirty tree or a different HEAD: a mismatch fails --prod
// builds (warning otherwise) and a dirty tree always gets the -dirty suffix.
const head = git('rev-parse', 'HEAD');
const dirty = git('status', '--porcelain') ? '-dirty' : '';
const override = process.env.PA_BUILD_COMMIT;
if (override && head && override !== head) {
  const m = `PA_BUILD_COMMIT (${override}) does not match git HEAD (${head})`;
  if (prod) { console.error(`build-main: ${m}`); process.exit(1); }
  console.warn(`build-main: warning: ${m}`);
}
const commit = (override || head || 'unknown') + dirty;
const common = {
  bundle: true, platform: 'node', format: 'cjs', conditions: ['source'], mainFields: ['module', 'main'], logLevel: 'error',
  define: { __PA_SMOKE__: prod ? 'false' : 'true', __PA_BUILD_COMMIT__: JSON.stringify(commit) }, minifySyntax: prod, absWorkingDir: app,
};
await build({ ...common, entryPoints: ['src/main/index.ts'], external: ['electron'], outfile: join(out, 'main/index.cjs') });
await build({ ...common, entryPoints: ['src/preload/index.ts'], external: ['electron'], outfile: join(out, 'preload/index.cjs') });
await build({ ...common, entryPoints: ['../../packages/pa-key/src/main.ts'], external: ['@napi-rs/keyring'], outfile: join(out, 'key-helper/pa-key.cjs') });
// Window/taskbar icon for Windows/Linux (macOS uses the bundle's .icns); ships inside app.asar via dist/**.
mkdirSync(out, { recursive: true });
copyFileSync(join(app, 'build/icon-window.png'), join(out, 'icon.png'));
if (prod) {
  const bad = ['main/index.cjs', 'preload/index.cjs', 'key-helper/pa-key.cjs']
    .filter((f) => /PA_SMOKE|runLoginSmoke|runUiSmokeStep|runKeysSmokeStep|smoke/i.test(readFileSync(join(out, f), 'utf8')));
  if (bad.length) { console.error(`production build still contains smoke code: ${bad.join(', ')}`); process.exit(1); }
}
console.log(`built main/preload/key-helper @ ${commit} (${prod ? 'production, no smoke code' : 'dev, smoke hooks included'})`);
