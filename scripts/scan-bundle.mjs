#!/usr/bin/env node
/* global process, console */
// M7 bundle scan: fails if a built bundle (default apps/desktop/dist) contains secrets or dangerous constructs.
//   node scripts/scan-bundle.mjs [dir...]
// Checks every .js/.cjs/.mjs/.html/.json/.map file for:
//   - secret-looking material: private keys, sk-<40+> API keys, GitHub/Slack/AWS tokens, Bearer <long token>
//   - main/preload only: weakened webPreferences, openDevTools, remote module, generic ipcRenderer exposure
// Upstream renderer code legitimately contains words like "token"; only concrete secret shapes are flagged.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SECRET = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----/],
  ['sk- API key', /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{40,}/],
  ['GitHub token', /\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{30,}/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{20,}/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Bearer literal', /Bearer [A-Za-z0-9._-]{32,}/],
];
const MAIN_ONLY = [
  ['nodeIntegration: true', /nodeIntegration\s*:\s*(?:true|!0)/],
  ['contextIsolation: false', /contextIsolation\s*:\s*(?:false|!1)/],
  ['sandbox: false', /sandbox\s*:\s*(?:false|!1)/],
  ['webSecurity: false', /webSecurity\s*:\s*(?:false|!1)/],
  ['openDevTools', /\.openDevTools\s*\(/],
  ['@electron/remote', /@electron\/remote/],
  ['raw ipcRenderer exposed', /exposeInMainWorld\(\s*["'][^"']+["']\s*,\s*(?:[\w$]+\.)?ipcRenderer\s*\)/],
];
const EXT = /\.(?:c|m)?js$|\.html$|\.json$|\.map$/;

function* walk(d) {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) yield* walk(p); else if (EXT.test(e)) yield p;
  }
}

export function scan(dirs) {
  const findings = [];
  for (const dir of dirs) {
    for (const f of walk(dir)) {
      const rel = relative(dir, f);
      const text = readFileSync(f, 'utf8');
      const isMain = !rel.split(sep).includes('renderer');
      for (const [name, re] of [...SECRET, ...(isMain ? MAIN_ONLY : [])]) {
        const m = re.exec(text);
        if (m) findings.push({ file: relative(ROOT, f), rule: name, at: m.index });
      }
    }
  }
  return findings;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const dirs = process.argv.slice(2).length ? process.argv.slice(2).map((d) => resolve(d)) : [join(ROOT, 'apps/desktop/dist')];
  for (const d of dirs) { try { statSync(d); } catch { console.error(`scan-bundle: ${d} does not exist (build first)`); process.exit(2); } }
  const found = scan(dirs);
  // Never print the match itself (it may be a secret): file, rule and offset only.
  for (const x of found) console.error(`scan-bundle: ${x.rule} in ${x.file} @${x.at}`);
  if (found.length) process.exit(1);
  console.log(`scan-bundle: clean (${dirs.map((d) => relative(ROOT, d) || '.').join(', ')})`);
}
