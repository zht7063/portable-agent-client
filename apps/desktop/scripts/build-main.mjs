/* global process, console */
// Bundles main, preload and the pa-key helper with esbuild.
//   node scripts/build-main.mjs          -> dev/test build: smoke hooks compiled in (PA_SMOKE=1 activates them)
//   node scripts/build-main.mjs --prod   -> production build: __PA_SMOKE__=false, smoke code folded away and
//                                           tree-shaken; the build fails if any smoke marker survives.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const prod = process.argv.includes('--prod') || process.env.PA_BUILD === 'production';
const out = process.env.PA_OUT_DIR ?? join(app, 'dist'); // tests build into a temp dir
const common = {
  bundle: true, platform: 'node', format: 'cjs', conditions: ['source'], mainFields: ['module', 'main'], logLevel: 'error',
  define: { __PA_SMOKE__: prod ? 'false' : 'true' }, minifySyntax: prod, absWorkingDir: app,
};
await build({ ...common, entryPoints: ['src/main/index.ts'], external: ['electron'], outfile: join(out, 'main/index.cjs') });
await build({ ...common, entryPoints: ['src/preload/index.ts'], external: ['electron'], outfile: join(out, 'preload/index.cjs') });
await build({ ...common, entryPoints: ['../../packages/pa-key/src/main.ts'], external: ['@napi-rs/keyring'], outfile: join(out, 'key-helper/pa-key.cjs') });
if (prod) {
  const bad = ['main/index.cjs', 'preload/index.cjs', 'key-helper/pa-key.cjs']
    .filter((f) => /PA_SMOKE|runLoginSmoke|runUiSmokeStep|runKeysSmokeStep|smoke/i.test(readFileSync(join(out, f), 'utf8')));
  if (bad.length) { console.error(`production build still contains smoke code: ${bad.join(', ')}`); process.exit(1); }
}
console.log(`built main/preload/key-helper (${prod ? 'production, no smoke code' : 'dev, smoke hooks included'})`);
