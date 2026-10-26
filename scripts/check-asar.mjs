#!/usr/bin/env node
/* global process, console */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, realpathSync, readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
const root = resolve(import.meta.dirname, '..');
const req = createRequire(join(root, 'apps/desktop/node_modules/electron-builder/package.json'));
const builderReq = createRequire(realpathSync(req.resolve('electron-builder/package.json')));
const libReq = createRequire(builderReq.resolve('app-builder-lib/package.json'));
const asar = libReq('@electron/asar');
const origin = JSON.parse(readFileSync(join(root, 'apps/desktop/build/server-origin.json'), 'utf8')).origin;
const snapshot = JSON.parse(readFileSync(join(root, 'apps/desktop/build/ipc-surface.prod.json'), 'utf8'));
const own = /^(?:src\/|\.\.\/\.\.\/packages\/(?:core|harness|keychain)\/src\/)/;
const fail = (m) => { throw new Error(`asar policy: ${m}`); };
function strings(node) {
  return ts.isArrayLiteralExpression(node) && node.elements.every(ts.isStringLiteral) ? node.elements.map((x) => x.text) : fail('nonliteral IPC schema');
}
export function inspect(dir) {
  const main = readFileSync(join(dir, 'dist/main/index.cjs'), 'utf8');
  const preload = readFileSync(join(dir, 'dist/preload/index.cjs'), 'utf8');
  if (!main.includes(JSON.stringify(origin))) fail('committed origin missing');
  if (/PA_SMOKE|PAC_SERVER_URL|smoke-gate|runLoginSmoke|key-helper/.test(main + preload)) fail('smoke/helper code present');
  const meta = JSON.parse(readFileSync(join(dir, 'dist/metafile.json'), 'utf8'));
  const surface = {};
  let bridge = [];
  for (const [kind, code] of [['main', main], ['preload', preload]]) {
    const output = Object.values(meta[kind].outputs).find((x) => x.entryPoint);
    if (!output) fail('metafile entry missing');
    const included = new Set(Object.entries(output.inputs).filter(([, v]) => v.bytesInOutput > 0).map(([p]) => p));
    // esbuild's non-minified module boundary comments map emitted code to metafile inputs;
    // third-party code is excluded. Fail closed if our entry was not located.
    const segments = [...code.matchAll(/^\/\/ ([^\n]+)\n([\s\S]*?)(?=^\/\/ [^\n]+\n|$(?![\s\S]))/gm)];
    let scanned = 0;
    for (const [, path, source] of segments) {
      if (!own.test(path) || !included.has(path)) continue;
      scanned++;
      const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const visit = (n) => {
        if (ts.isVariableDeclaration(n) && n.name.getText(ast) === 'IPC_FIELDS' && n.initializer && ts.isObjectLiteralExpression(n.initializer)) {
          for (const prop of n.initializer.properties) {
            if (!ts.isPropertyAssignment(prop)) fail('nonliteral IPC surface');
            surface[prop.name.text] = strings(prop.initializer);
          }
        }
        if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
          const base = n.expression.getText(ast);
          if (base === 'process.env' && !path.endsWith('/env-scan.ts')) {
            const key = ts.isPropertyAccessExpression(n) ? n.name.text : ts.isStringLiteral(n.argumentExpression) ? n.argumentExpression.text : null;
            if (!key || /URL|HOST|ORIGIN|ENDPOINT|SERVER/i.test(key)) fail(`URL/dynamic environment access in ${path}`);
          }
          // Forbid aliasing/destructuring process.env (env-scan explicitly allowlisted).
          if (base === 'process' && (n.name?.text === 'env' || n.argumentExpression?.text === 'env') && !path.endsWith('/env-scan.ts')) {
            if (!(ts.isPropertyAccessExpression(n.parent) || ts.isElementAccessExpression(n.parent)) && !path.endsWith('/index.ts') && !path.endsWith('/harness-host.ts')) fail(`environment alias in ${path}`);
          }
        }
        if (ts.isStringLiteral(n) && /^https?:\/\/[^/]/.test(n.text) && n.text !== origin && !snapshot.documentUrls.includes(n.text)) fail(`foreign URL literal in ${path}`);
        ts.forEachChild(n, visit);
      };
      visit(ast);
    }
    if (!scanned) fail(`no own modules scanned for ${kind}`);
  }
  bridge = [...preload.matchAll(/call\(["']([^"']+)["']\)/g)].map((m) => m[1]).sort();
  if (JSON.stringify(bridge) !== JSON.stringify(Object.keys(snapshot.fields).sort())) fail('preload channels changed');
  if (JSON.stringify(surface) !== JSON.stringify(snapshot.fields)) fail('strict IPC fields changed');
  if (surface['config:set'].includes('serverUrl')) fail('mutable origin');
  console.log(`asar policy: passed (${dir})`);
}
function walk(dir) { return readdirSync(dir, { withFileTypes: true }).flatMap((d) => d.isSymbolicLink() ? [] : d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]); }
async function checkArtifact(file) {
  const tmp = mkdtempSync(join(tmpdir(), 'swift-asar-'));
  let mount;
  try {
    let archives;
    if (file.endsWith('.asar')) archives = [file];
    else if (file.endsWith('.dmg')) {
      mount = join(tmp, 'mount'); mkdirSync(mount);
      execFileSync('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, file]);
      archives = walk(mount).filter((p) => p.endsWith('/app.asar'));
    } else if (file.endsWith('.exe')) {
      const unpack = join(tmp, 'installer');
      const seven = libReq('7zip-bin').path7za;
      execFileSync(seven, ['x', file, `-o${unpack}`, '-y']);
      for (const p of walk(unpack).filter((p) => /\.7z$/.test(p))) execFileSync(seven, ['x', p, `-o${unpack}/payload`, '-y']);
      archives = walk(unpack).filter((p) => p.endsWith('app.asar'));
    } else { inspect(file); return; }
    if (!archives.length) fail('artifact contains no app.asar');
    for (const [i, archive] of archives.entries()) { const dest = join(tmp, `app-${i}`); asar.extractAll(archive, dest); inspect(dest); }
  } finally { if (mount) execFileSync('hdiutil', ['detach', mount]); rmSync(tmp, { recursive: true, force: true }); }
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const artifacts = args.length ? args.map((p) => resolve(p)) : walk(join(root, 'apps/desktop/release')).filter((p) => /\.(dmg|exe)$/.test(p));
  if (!artifacts.length || artifacts.some((p) => !existsSync(p))) fail('no release artifacts');
  for (const file of artifacts) await checkArtifact(file);
}
