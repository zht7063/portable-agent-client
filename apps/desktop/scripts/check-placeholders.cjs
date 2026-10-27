// Aegis M6 item 6: a build must not ship the unreplaced source-offer placeholders (AGPL §6/§13 source offer).
// product.config.json keeps the placeholders for now; any packaging run fails while they are unreplaced unless the
// build is explicitly a LOCAL one (PA_LOCAL_BUILD=1, set only by pack:dir and the pack:*:local scripts, whose
// artifacts are named *-LOCAL and are never distributed). The official pack scripts run
// `node scripts/check-placeholders.cjs --official` with PA_LOCAL_BUILD=0 (an inherited PA_LOCAL_BUILD=1 cannot bypass
// it) and additionally verify that the source URL is anonymously reachable at the build commit.
/* global module, require, process, console, URL, fetch, AbortSignal, __dirname */
'use strict';

/** Hosts accepted for a public source URL (AGPL §13 "Corresponding Source" location). */
const SOURCE_HOSTS = ['github.com', 'gitlab.com', 'codeberg.org'];
/** Text that marks an unfinished value: PLACEHOLDER / place-holder, TODO, TBD, FIXME, <...>, example.invalid. */
const PLACEHOLDER_RE = /place[\s_-]?holder|\bTODO\b|\bTBD\b|\bFIXME\b|<[^<>]*>|example\.invalid/i;
const OFFER_MIN_LENGTH = 120;

/** Returns null if url is an acceptable public source URL, else the reason. */
function sourceUrlProblem(url) {
  if (PLACEHOLDER_RE.test(url)) return 'placeholder text';
  let u;
  try { u = new URL(url.trim()); } catch { return 'not a URL'; }
  if (u.protocol !== 'https:') return 'not https';
  if (u.username || u.password || /@/.test(url.split('/')[2] ?? '')) return 'userinfo not allowed';
  if (u.port) return 'explicit port not allowed';
  const host = u.hostname.toLowerCase();
  if (/^\d+(\.\d+){3}$/.test(host) || host.includes(':') || host.startsWith('[')) return 'IP address not allowed';
  if (host === 'localhost' || /\.(localhost|example|invalid|test|local)$/.test(host) || /(^|\.)example\.(com|org|net)$/.test(host)) return 'reserved/example host';
  if (!SOURCE_HOSTS.includes(host)) return `host not in allowlist (${SOURCE_HOSTS.join(', ')})`;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length !== 2 || u.search || u.hash) return 'must be https://<host>/<owner>/<repo>';
  if (parts.some((p) => /^(TODO|TBD|FIXME|XXX)$/i.test(p))) return 'TODO/TBD in path';
  return null;
}

/** Returns null if text is an acceptable written source offer, else the reason. */
function sourceOfferProblem(text) {
  const t = text.trim();
  if (PLACEHOLDER_RE.test(t)) return 'placeholder text';
  if (t.length < OFFER_MIN_LENGTH) return `shorter than ${OFFER_MIN_LENGTH} characters`;
  if (!/\bvalid\b[^.]*\b(for|until|through)\b|\b(at least|for)\s+(three|3|\d+)\s+years?\b/i.test(t)) return 'no validity period (e.g. "valid for at least three years")';
  if (!/[\w.+-]+@[\w-]+(\.[\w-]+)+|https:\/\/\S+/.test(t)) return 'no contact (email address or https URL)';
  return null;
}

/**
 * Returns the unreplaced/invalid fields (empty = ok). AGPL §6/§13 needs ONE way to get the source: a public https
 * sourceUrl on an allowlisted host (decision a) or a written sourceOffer (decision b). A field still listed in
 * "$placeholders", or a present value that is invalid, is always reported (it would be shown in About as-is).
 */
function placeholderProblems(product) {
  const listed = new Set(Array.isArray(product.$placeholders) ? product.$placeholders : []);
  const present = (k) => typeof product[k] === 'string' && product[k].trim() !== '';
  const out = {};
  for (const k of ['sourceUrl', 'sourceOffer']) {
    if (listed.has(k)) out[k] = 'listed in $placeholders';
    else if (present(k)) { const p = (k === 'sourceUrl' ? sourceUrlProblem : sourceOfferProblem)(product[k]); if (p) out[k] = p; }
  }
  const ok = (k) => present(k) && !out[k];
  if (!ok('sourceUrl') && !ok('sourceOffer')) for (const k of ['sourceUrl', 'sourceOffer']) if (!present(k)) out[k] = 'missing';
  return out;
}
const unreplacedPlaceholders = (product) => Object.keys(placeholderProblems(product)).sort();

/** Throws unless placeholders are replaced or env.PA_LOCAL_BUILD === '1'. Returns a warning string for local builds. */
function assertNoPlaceholders(product, env) {
  const probs = placeholderProblems(product);
  const bad = Object.keys(probs).sort();
  if (bad.length === 0) return null;
  const msg = `unreplaced placeholder(s) in packages/core/src/product.config.json: ${bad.map((k) => `${k} (${probs[k]})`).join(', ')}`;
  if (env.PA_LOCAL_BUILD === '1') return `WARNING: LOCAL build (PA_LOCAL_BUILD=1), not for distribution: ${msg}`;
  throw new Error(`${msg}. Replace them before a release build, or use a pack:*:local script (PA_LOCAL_BUILD=1) for a LOCAL build.`);
}

/**
 * Official release check: placeholders replaced (PA_LOCAL_BUILD is ignored) and, if a sourceUrl is used, an anonymous
 * GET of <sourceUrl>/tree/<commit> returns 200 (no redirects, no credentials). fetchImpl is injectable for tests.
 */
async function assertOfficialRelease(product, { commit, fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  assertNoPlaceholders(product, {});
  if (!commit || !/^[0-9a-f]{40}$/.test(commit)) throw new Error(`official build needs a clean 40-hex build commit (got ${JSON.stringify(commit)})`);
  if (typeof product.sourceUrl !== 'string' || !product.sourceUrl.trim()) return; // decision (b): written offer only
  const url = `${product.sourceUrl.trim().replace(/\/+$/, '')}/tree/${commit}`;
  let status;
  try { status = (await fetchImpl(url, { method: 'GET', redirect: 'manual', credentials: 'omit', headers: { 'user-agent': 'portable-agent-release-check' }, signal: AbortSignal.timeout(timeoutMs) })).status; }
  catch (e) {
    const why = e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? `timed out after ${timeoutMs} ms` : e.message;
    throw new Error(`source URL check failed for ${url}: ${why}`);
  }
  if (status !== 200) throw new Error(`source URL ${url} is not anonymously reachable at the build commit (HTTP ${status}; need 200)`);
}

/**
 * Official build commit: the git HEAD of a clean working tree. PA_BUILD_COMMIT, if set, must equal HEAD (it cannot
 * be used to skip the HEAD/dirty checks). gitImpl(...args) -> stdout is injectable for tests.
 */
function buildCommit(env = process.env, gitImpl) {
  const git = gitImpl ?? ((...a) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execFileSync } = require('node:child_process');
    return execFileSync('git', a, { cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  });
  const head = String(git('rev-parse', 'HEAD')).trim();
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error(`cannot determine git HEAD (got ${JSON.stringify(head)})`);
  if (String(git('status', '--porcelain')).trim()) throw new Error('working tree is dirty; official builds need a clean checkout');
  if (env.PA_BUILD_COMMIT && env.PA_BUILD_COMMIT !== head) throw new Error(`PA_BUILD_COMMIT (${env.PA_BUILD_COMMIT}) does not match git HEAD (${head})`);
  return head;
}

/** Read relative to this script, report an actionable error rather than MODULE_NOT_FOUND. */
function assertProductionOrigin() {
  let origin;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    origin = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '../build/server-origin.json'), 'utf8')).origin;
    const url = new URL(origin);
    // Build-time guard only: the runtime accepts http(s) and warns on non-HTTPS (insecureTransport). Plain http is
    // explicitly allowed for the beta.2 bare-IP server; keys travel in cleartext until an https:// origin lands.
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.origin !== origin) throw new Error('expected a bare http(s) origin');
    if (url.protocol === 'http:') console.warn(`warning: server origin ${origin} is plain HTTP; credentials travel in cleartext`);
    if (/\.invalid$/.test(url.hostname)) throw new Error('D-17 production HTTPS origin is still a placeholder');
  } catch (e) { throw new Error(`cannot use build/server-origin.json: ${e.message}`); }
}

module.exports = { SOURCE_HOSTS, PLACEHOLDER_RE, sourceUrlProblem, sourceOfferProblem, placeholderProblems, unreplacedPlaceholders, assertNoPlaceholders, assertOfficialRelease, buildCommit };

// CLI: `node scripts/check-placeholders.cjs [--official]` — the pack scripts run this first so they refuse before building.
if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const product = require('../../../packages/core/src/product.config.json');
  const fail = (e) => { console.error(`refusing to package: ${e.message}`); process.exit(1); };
  if (process.argv.includes('--official')) {
    let commit; try { assertNoPlaceholders(product, {}); commit = buildCommit(); assertProductionOrigin(); } catch (e) { fail(e); }
    assertOfficialRelease(product, { commit }).then(() => console.log(`official release check passed (${commit})`), fail);
  } else {
    try { const w = assertNoPlaceholders(product, process.env); if (w) console.warn(w); } catch (e) { fail(e); }
  }
}
