#!/usr/bin/env node
/* global process, console */
// M7 bundle scan: fails if a built bundle (default apps/desktop/dist) contains secrets or dangerous constructs.
//   node scripts/scan-bundle.mjs [dir...]   (default: apps/desktop/dist and, if present, apps/desktop/release)
// Checks every .js/.cjs/.mjs/.html/.json/.map/.txt/.svg file, also inside .asar archives (read in memory with a
// minimal asar header parser, no extraction, no dependency), for:
//   - secret-looking material: private keys, sk-<40+> API keys, GitHub/Slack/AWS tokens, Bearer <long token>,
//     unprefixed 48-char new-api keys. Heuristic for the latter (to avoid hashes/IDs): exactly 48 [A-Za-z0-9] chars,
//     quoted, directly assigned to a key-like name (key/token/secret/apiKey/authorization...) and containing upper
//     case, lower case and a digit (so hex digests and single-case IDs never match).
//   - main/preload only: weakened webPreferences, openDevTools, remote module, generic ipcRenderer exposure
// Upstream renderer code legitimately contains words like "token"; only concrete secret shapes are flagged.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = resolve(import.meta.dirname, '..');
const SECRET = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----/],
  ['sk- API key', /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{40,}/],
  ['GitHub token', /\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{30,}/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{20,}/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Bearer literal', /Bearer [A-Za-z0-9._-]{32,}/],
  ['bare 48-char key', /(?:[Kk]ey|KEY|[Tt]oken|TOKEN|[Ss]ecret|SECRET|[Aa]uthorization|AUTHORIZATION|[Cc]redential|CREDENTIAL)["']?\s*[:=]\s*["'`](?=[A-Za-z0-9]{0,47}[a-z])(?=[A-Za-z0-9]{0,47}[A-Z])(?=[A-Za-z0-9]{0,47}[0-9])[A-Za-z0-9]{48}["'`]/],
];
/*
 * Bare 48-char high-entropy strings without keyword context. Same heuristic as looksLikeBareKey in
 * apps/desktop/src/main/proxy/sanitize.ts: upper + lower + digit, not hex/UUID/single-case, not identifier+number,
 * >= 6 switches between lower/upper/digit. Known non-secrets are suppressed via scripts/scan-bundle-allowlist.json
 * (sha256 of the string + justification; the string itself is never stored or printed).
 */
const BARE48 = /(?<![A-Za-z0-9_+/-])[A-Za-z0-9]{48}(?![A-Za-z0-9_+/=-])/g;
export function highEntropy(s) {
  if (!/[a-z]/.test(s) || !/[A-Z]/.test(s) || !/[0-9]/.test(s)) return false;
  if (/^[0-9a-f]+$/i.test(s) || /^[0-9a-z_-]+$/.test(s) || /^[0-9A-Z_-]+$/.test(s) || /^[A-Za-z_-]+[0-9]*$/.test(s)) return false;
  const cls = (c) => (/[a-z]/.test(c) ? 0 : /[A-Z]/.test(c) ? 1 : 2);
  let n = 0;
  for (let i = 1; i < s.length; i++) if (cls(s[i]) !== cls(s[i - 1])) n++;
  return n >= 6;
}
const sha = (s) => createHash('sha256').update(s).digest('hex');
const ALLOW_FILE = join(ROOT, 'scripts/scan-bundle-allowlist.json');
/**
 * Allowlist entries: { sha256, paths: [glob...], reason }. A hit is suppressed only if BOTH the sha256 matches AND its
 * path matches one of the globs. Paths are relative to the scanned directory; files inside an archive use
 * `<path-to.asar>:<path-inside-asar>`. Glob: `**` followed by a slash = any directories, `*` = any chars except / and :.
 * PA_SCAN_ALLOWLIST (alternate file) is for local testing only and is refused in CI (CI / GITHUB_ACTIONS = true or 1, any case).
 */
export function globToRegExp(g) {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    if (g.startsWith('**/', i)) { re += '(?:.*/)?'; i += 2; } else if (g[i] === '*') re += '[^/:]*';
    else re += g[i].replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
const truthy = (v) => /^(?:true|1)$/i.test(String(v ?? '').trim());
export const isCI = (env = process.env) => truthy(env.CI) || truthy(env.GITHUB_ACTIONS);
export function loadAllowlist(env = process.env) {
  let file = ALLOW_FILE;
  if (env.PA_SCAN_ALLOWLIST) {
    if (isCI(env)) throw new Error('PA_SCAN_ALLOWLIST override is refused in CI');
    file = env.PA_SCAN_ALLOWLIST;
  }
  if (!existsSync(file)) return [];
  const list = JSON.parse(readFileSync(file, 'utf8')).entries ?? [];
  for (const e of list) {
    if (!/^[0-9a-f]{64}$/.test(e.sha256) || !e.reason || !Array.isArray(e.paths) || !e.paths.length) {
      throw new Error(`allowlist entry needs sha256 + paths + reason: ${JSON.stringify(e)}`);
    }
  }
  return list.map((e) => ({ sha256: e.sha256, paths: e.paths.map(globToRegExp) }));
}
const allowed = (allow, h, path) => allow.some((e) => e.sha256 === h && e.paths.some((re) => re.test(path)));
const MAIN_ONLY = [
  ['nodeIntegration: true', /nodeIntegration\s*:\s*(?:true|!0)/],
  ['contextIsolation: false', /contextIsolation\s*:\s*(?:false|!1)/],
  ['sandbox: false', /sandbox\s*:\s*(?:false|!1)/],
  ['webSecurity: false', /webSecurity\s*:\s*(?:false|!1)/],
  ['openDevTools', /\.openDevTools\s*\(/],
  ['@electron/remote', /@electron\/remote/],
  ['raw ipcRenderer exposed', /exposeInMainWorld\(\s*["'][^"']+["']\s*,\s*(?:[\w$]+\.)?ipcRenderer\s*\)/],
];
const EXT = /\.(?:c|m)?js$|\.html$|\.json$|\.map$|\.txt$|\.svg$/;

function* walk(d) {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) yield* walk(p); else if (EXT.test(e) || e.endsWith('.asar')) yield p;
  }
}

/** Minimal asar reader: yields [path, Buffer] for every packed file (unpacked ones live on disk and are walked). */
export function* asarEntries(file) {
  const buf = readFileSync(file);
  if (buf.length < 16 || buf.readUInt32LE(0) !== 4) throw new Error('not an asar archive');
  const headerSize = buf.readUInt32LE(4);
  const jsonLen = buf.readInt32LE(12);
  const header = JSON.parse(buf.subarray(16, 16 + jsonLen).toString('utf8'));
  const base = 8 + headerSize;
  function* rec(node, prefix) {
    for (const [name, e] of Object.entries(node.files ?? {})) {
      const p = prefix ? `${prefix}/${name}` : name;
      if (e.files) yield* rec(e, p);
      else if (!e.unpacked && !e.link && e.offset !== undefined) {
        const off = base + Number(e.offset);
        yield [p, buf.subarray(off, off + e.size)];
      }
    }
  }
  yield* rec(header, '');
}

function check(findings, label, rel, text, allow) {
  for (const m of text.matchAll(BARE48)) {
    if (!highEntropy(m[0])) continue;
    const h = sha(m[0]);
    if (!allowed(allow, h, rel.split(sep).join('/'))) findings.push({ file: label, rule: 'bare 48-char high-entropy string', at: m.index, sha256: h });
  }
  const parts = rel.split(/[/\\]/);
  // main/preload rules apply to our own code only (not the renderer, not third-party node_modules).
  const isMain = !parts.includes('renderer') && !parts.includes('node_modules');
  for (const [name, re] of [...SECRET, ...(isMain ? MAIN_ONLY : [])]) {
    const m = re.exec(text);
    if (m) findings.push({ file: label, rule: name, at: m.index });
  }
}

export function scan(dirs, allow = loadAllowlist()) {
  const findings = [];
  for (const dir of dirs) {
    for (const f of walk(dir)) {
      const rel = relative(dir, f);
      if (f.endsWith('.asar')) {
        let entries;
        try { entries = [...asarEntries(f)]; } catch { findings.push({ file: relative(ROOT, f), rule: 'unreadable asar', at: 0 }); continue; }
        for (const [p, data] of entries) if (EXT.test(p)) check(findings, `${relative(ROOT, f)}:${p}`, `${rel}:${p}`, data.toString('utf8'), allow);
        continue;
      }
      check(findings, relative(ROOT, f), rel, readFileSync(f, 'utf8'), allow);
    }
  }
  return findings;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const rel = join(ROOT, 'apps/desktop/release');
  const dirs = process.argv.slice(2).length ? process.argv.slice(2).map((d) => resolve(d))
    : [join(ROOT, 'apps/desktop/dist'), ...(existsSync(rel) ? [rel] : [])];
  for (const d of dirs) { try { statSync(d); } catch { console.error(`scan-bundle: ${d} does not exist (build first)`); process.exit(2); } }
  let allow;
  try { allow = loadAllowlist(); } catch (e) { console.error(`scan-bundle: ${e.message}`); process.exit(2); }
  const found = scan(dirs, allow);
  // Never print the match itself (it may be a secret): file, rule, offset (and sha256 for allowlisting) only.
  for (const x of found) console.error(`scan-bundle: ${x.rule} in ${x.file} @${x.at}${x.sha256 ? ` sha256=${x.sha256}` : ''}`);
  if (found.length) process.exit(1);
  console.log(`scan-bundle: clean (${dirs.map((d) => relative(ROOT, d) || '.').join(', ')})`);
}
