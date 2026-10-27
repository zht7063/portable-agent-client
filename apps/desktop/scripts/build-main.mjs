/* global process, console, URL */
// Bundles main, preload and the pa-key helper with esbuild.
//   node scripts/build-main.mjs          -> dev/test build: smoke hooks compiled in (PA_SMOKE=1 activates them)
//   node scripts/build-main.mjs --prod   -> production build: __PA_SMOKE__=false, smoke code folded away and
//                                           tree-shaken; the build fails if any smoke marker survives.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
const origin = JSON.parse(readFileSync(join(app, 'build/server-origin.json'), 'utf8')).origin;
// http: explicitly allowed (beta.2 bare-IP server, cleartext); the runtime flags it as insecureTransport.
if (!['https:', 'http:'].includes(new URL(origin).protocol) || new URL(origin).origin !== origin) throw new Error('Invalid committed origin');
const common = {
  bundle: true, platform: 'node', format: 'cjs', conditions: ['source'], mainFields: ['module', 'main'], logLevel: 'error',
  metafile: true,
  define: { __SERVER_ORIGIN__: JSON.stringify(origin), __PA_SMOKE__: prod ? 'false' : 'true', __PA_BUILD_COMMIT__: JSON.stringify(commit) }, minifySyntax: prod, absWorkingDir: app,
};
const mainBuild = await build({ ...common, entryPoints: ['src/main/index.ts'], external: ['electron'], outfile: join(out, 'main/index.cjs') });
const preloadBuild = await build({ ...common, entryPoints: ['src/preload/index.ts'], external: ['electron'], outfile: join(out, 'preload/index.cjs') });
// Window/taskbar icon for Windows/Linux (macOS uses the bundle's .icns); ships inside app.asar via dist/**.
mkdirSync(out, { recursive: true });
const retainedMeta = (meta) => {
  const retained = new Set(Object.values(meta.outputs).flatMap((output) => Object.entries(output.inputs).filter(([, v]) => v.bytesInOutput > 0).map(([name]) => name)));
  return { inputs: Object.fromEntries(Object.entries(meta.inputs).filter(([name]) => retained.has(name)).map(([name, value]) => [name, { ...value, imports: value.imports.filter((i) => i.external || retained.has(i.path)) }])), outputs: meta.outputs };
};
writeFileSync(join(out, 'metafile.json'), JSON.stringify({ main: retainedMeta(mainBuild.metafile), preload: retainedMeta(preloadBuild.metafile) }));
copyFileSync(join(app, 'build/icons/256x256.png'), join(out, 'icon.png'));
if (prod) {
  const bad = ['main/index.cjs', 'preload/index.cjs']
    .filter((f) => /PA_SMOKE|runLoginSmoke|runUiSmokeStep|runKeysSmokeStep|smoke/i.test(readFileSync(join(out, f), 'utf8')));
  if (bad.length) { console.error(`production build still contains smoke code: ${bad.join(', ')}`); process.exit(1); }
}
console.log(`built main/preload @ ${commit} (${prod ? 'production, no smoke code' : 'dev, smoke hooks included'})`);
