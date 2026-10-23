#!/usr/bin/env node
/* global process, console */
/**
 * Validates compat.json (plan v2 §4): the pinned upstream new-api tag/commit and the server compatibility window.
 * Usage: node scripts/compat-check.mjs [--server vX.Y.Z[-rc.N]]  -> also reports whether that server version is accepted.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = /^v(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.(\d+))?$/;

export function parseVersion(v) {
  const m = VERSION.exec(String(v ?? ''));
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? [m[4], +m[5]] : null };
}
export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) throw new Error(`invalid version: ${!x ? a : b}`);
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] - y[k];
  if (!x.pre || !y.pre) return (x.pre ? -1 : 0) - (y.pre ? -1 : 0);
  return x.pre[0] !== y.pre[0] ? (x.pre[0] < y.pre[0] ? -1 : 1) : x.pre[1] - y.pre[1];
}
export function validateCompat(c) {
  const errors = [];
  if (c.upstream !== 'https://github.com/QuantumNous/new-api') errors.push('upstream must be the new-api repository URL');
  if (!parseVersion(c.tag)) errors.push(`tag "${c.tag}" is not a new-api version tag`);
  if (!/^[0-9a-f]{40}$/.test(String(c.commit))) errors.push('commit must be a full 40-hex SHA');
  if (!parseVersion(c.minServer)) errors.push('minServer must be a version');
  if (c.maxServerTested !== null && !parseVersion(c.maxServerTested)) errors.push('maxServerTested must be a version or null');
  if (!['same-minor-line', 'exact'].includes(c.policy)) errors.push('policy must be "same-minor-line" or "exact"');
  if (!errors.length && compareVersions(c.minServer, c.tag) > 0) errors.push('minServer must not be newer than the pinned tag');
  return errors;
}
/** 'ok' | 'untested' (newer than tested, same line: warn) | 'too-old' | 'incompatible' (other minor line / exact mismatch). */
export function serverCompat(c, server) {
  const s = parseVersion(server);
  if (!s) return 'incompatible';
  if (compareVersions(server, c.minServer) < 0) return 'too-old';
  const t = parseVersion(c.tag);
  if (c.policy === 'exact') return compareVersions(server, c.tag) === 0 ? 'ok' : 'incompatible';
  if (s.major !== t.major || s.minor !== t.minor) return 'incompatible';
  const ceiling = c.maxServerTested ?? c.tag;
  return compareVersions(server, ceiling) <= 0 ? 'ok' : 'untested';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const c = JSON.parse(readFileSync(join(root, 'compat.json'), 'utf8'));
  const errors = validateCompat(c);
  if (errors.length) { console.error(errors.map((e) => `compat.json: ${e}`).join('\n')); process.exit(1); }
  console.log(`compat ok: pinned ${c.tag} (${c.commit.slice(0, 12)}), minServer ${c.minServer}, policy ${c.policy}`);
  const i = process.argv.indexOf('--server');
  if (i > 0) console.log(`server ${process.argv[i + 1]}: ${serverCompat(c, process.argv[i + 1])}`);
}
