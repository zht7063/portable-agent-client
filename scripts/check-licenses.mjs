#!/usr/bin/env node
/* global process, console */
/**
 * License gate: every third-party production dependency (transitively, incl. installed optional deps) of our
 * workspaces must be MIT / ISC / BSD / Apache-2.0 (or an SPDX expression satisfiable with those) — all
 * AGPL-3.0-compatible. Our own @pac/* packages are AGPL-3.0-only. Dev dependencies are not shipped and are not checked.
 * `--write` regenerates THIRD-PARTY-LICENSES.md.
 * M2: also checks the vendored new-api web frontend's production dependencies (resolved from the .build copy made by
 * scripts/build-new-api-web.sh; skipped with a warning if it has not been built). For the web bundle only, a few
 * extra licenses are accepted but FLAGGED in the output/report (WEB_FLAGGED) — see THIRD-PARTY-LICENSES.md.
 */
import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD']);
/**
 * Packages that are installed but must NOT be shipped/loaded (documented in docs/harness.md):
 * the Linux @napi-rs/keyring binaries statically link libdbus (AFL-2.1 OR GPL-2.0-or-later); on Linux we use the
 * system `secret-tool` instead and packaging must exclude these binaries.
 */
const NOT_SHIPPED = [/^@napi-rs\/keyring-linux-/, /^@napi-rs\/keyring-freebsd-/];
/**
 * Web-bundle-only: AGPL-compatible but not on the permissive allowlist; accepted with a flag (needs owner sign-off).
 *  - OFL-1.1: @fontsource-variable/* font files (bundled woff2; OFL text must accompany the fonts)
 *  - Unlicense: public-domain dedication (isbot, text-encoding)
 */
const WEB_FLAGGED = new Set(['OFL-1.1', 'Unlicense']);
/** Web deps installed but not part of the browser bundle (Node-only native optional loaders, verified absent from dist). */
const WEB_NOT_SHIPPED = [/^@resvg\/resvg-js/];

export function spdxAllowed(expr) {
  const e = String(expr ?? '').trim().replace(/^\((.*)\)$/, '$1');
  if (!e) return false;
  if (/\s+OR\s+/i.test(e)) return e.split(/\s+OR\s+/i).some(spdxAllowed);
  if (/\s+AND\s+/i.test(e)) return e.split(/\s+AND\s+/i).every(spdxAllowed);
  return ALLOWED.has(e);
}

/** Expands "dir/*" workspace globs (the only form we use). */
const workspaces = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).workspaces.flatMap((w) =>
  w.endsWith('/*') ? readdirSync(join(root, w.slice(0, -2)), { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(root, w.slice(0, -2), d.name, 'package.json'))).map((d) => `${w.slice(0, -2)}/${d.name}`) : [w]);
const seen = new Map();
const problems = [];
const warnings = [];

function resolvePkg(name, fromDir) {
  for (let d = fromDir; ; d = dirname(d)) {
    const p = join(d, 'node_modules', name, 'package.json');
    if (existsSync(p)) return p;
    if (dirname(d) === d) return null;
  }
}

function visit(name, fromDir, optional, web = false) {
  const pj = resolvePkg(name, fromDir);
  if (!pj) { if (!optional) problems.push(`${name}: not installed`); return; }
  if (seen.has(pj)) return;
  const pkg = JSON.parse(readFileSync(pj, 'utf8'));
  seen.set(pj, pkg);
  if (pkg.private && name.startsWith('@pac/')) { /* our own workspace */ }
  else {
    const lic = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type;
    if (web && WEB_NOT_SHIPPED.some((r) => r.test(name))) { webExcluded.add(pj); warnings.push(`web: ${name}@${pkg.version} (${lic}): installed but not in the browser bundle (Node-only native loader)`); }
    else if (web && !spdxAllowed(lic) && WEB_FLAGGED.has(lic)) { webFlagged.push(`${name}@${pkg.version} (${lic})`); webFlaggedDirs.push({ id: `${name}@${pkg.version} (${lic})`, dir: dirname(pj) }); }
    else if (NOT_SHIPPED.some((r) => r.test(name))) warnings.push(`${name}@${pkg.version} (${lic}): installed but excluded from shipping (bundles libdbus AFL-2.1 OR GPL-2.0+)`);
    else if (!spdxAllowed(lic)) problems.push(`${name}@${pkg.version}: license "${lic ?? 'none'}" not allowed`);
  }
  const dir = dirname(pj);
  for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dep, dir, false, web);
  for (const dep of Object.keys(pkg.optionalDependencies ?? {})) visit(dep, dir, true, web);
}
const webExcluded = new Set();
const webFlagged = [];
/** Flagged web packages whose license text must ship with the bundle (OFL-1.1 requires it). */
const webFlaggedDirs = [];
const licenseFile = (dir) => readdirSync(dir).find((f) => /^(LICEN[CS]E|COPYING)(\.(md|txt))?$/i.test(f));
const webDir = join(root, '.build', 'new-api-web');
const licOf = (p) => (typeof p.license === 'string' ? p.license : p.license?.type);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const ws of workspaces) {
    const pkg = JSON.parse(readFileSync(join(root, ws, 'package.json'), 'utf8'));
    for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dep, join(root, ws), false);
  }
  const appSeen = new Map(seen);
  seen.clear();
  let webBuilt = existsSync(join(webDir, 'node_modules'));
  if (webBuilt) {
    const wpkg = JSON.parse(readFileSync(join(root, 'vendor', 'new-api-web', 'package.json'), 'utf8'));
    for (const dep of Object.keys(wpkg.dependencies ?? {})) visit(dep, webDir, false, true);
  } else warnings.push('web: .build/new-api-web not built; run scripts/build-new-api-web.sh to check the vendored frontend');
  const webSeen = new Map(seen);
  seen.clear();
  for (const [k, v] of appSeen) seen.set(k, v);
  const webRows = [...webSeen.entries()].filter(([pj]) => !webExcluded.has(pj)).map(([, p]) => p).sort((a, b) => a.name.localeCompare(b.name));
  const listed = [...seen.values()].filter((p) => !p.name.startsWith('@pac/')).map((p) => `${p.name}@${p.version} ${typeof p.license === 'string' ? p.license : p.license?.type}`).sort();
  console.log(listed.join('\n'));
  for (const w of warnings) console.warn(`warning: ${w}`);
  for (const f of webFlagged) console.warn(`FLAG (web bundle, non-allowlisted but AGPL-compatible): ${f}`);
  if (problems.length) { console.error(problems.map((p) => `license: ${p}`).join('\n')); process.exit(1); }
  if (process.argv.includes('--write')) {
    const rows = [...seen.values()].filter((p) => !p.name.startsWith('@pac/') && !NOT_SHIPPED.some((r) => r.test(p.name)))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => `| ${p.name} | ${p.version} | ${typeof p.license === 'string' ? p.license : p.license?.type} |`);
    writeFileSync(join(root, 'THIRD-PARTY-LICENSES.md'), [
      '# Third-party licenses', '',
      '<!-- Generated by `node scripts/check-licenses.mjs --write`. Do not edit by hand. -->', '',
      'This project is licensed under AGPL-3.0 (see LICENSE and NOTICE). It bundles the following third-party',
      'production dependencies of the desktop client and its packages. Full license texts ship inside each package.', '',
      'Electron runtime notices are added in a later milestone (M6).', '',
      '## Desktop client and packages', '',
      '| Package | Version | License |', '|---|---|---|', ...rows, '',
      '## Vendored new-api web frontend (bundled renderer)', '',
      'new-api web (QuantumNous/new-api `web/`, AGPL-3.0, see vendor/new-api-web/UPSTREAM, LICENSE, NOTICE.upstream),',
      'patched per patches/new-api-web/README.md. Its production dependencies:', '',
      ...(webBuilt ? [] : ['_(not generated: .build/new-api-web missing)_', '']),
      '**Flagged (not on the permissive allowlist, AGPL-compatible, accepted pending owner sign-off):** ' + (webFlagged.length ? webFlagged.join(', ') : 'none') + '.', '',
      '| Package | Version | License |', '|---|---|---|', ...webRows.map((p) => `| ${p.name} | ${p.version} | ${licOf(p)} |`), '',
      ...(webFlaggedDirs.length ? ['## Full license texts of flagged bundled packages', '',
        'Shipped verbatim (also copied to `dist/renderer/licenses/` by scripts/build-new-api-web.sh). The SIL Open Font',
        'License 1.1 requires its text to accompany the bundled font files.', '',
        ...webFlaggedDirs.flatMap(({ id, dir }) => { const f = licenseFile(dir); return [`### ${id}`, '', '```text', f ? readFileSync(join(dir, f), 'utf8').trimEnd() : '(no license file in package)', '```', '']; })] : []),
    ].join('\n'));
  }
  console.log(`license check ok (${listed.length} production packages; web bundle ${webRows.length}, flagged ${webFlagged.length})`);
}
