// Aegis M6 item 6: a build must not ship the unreplaced source-offer placeholders (AGPL §6/§13 source offer).
// product.config.json keeps the placeholders for now; any packaging run fails while they are unreplaced unless the
// build is explicitly a LOCAL one (PA_LOCAL_BUILD=1, set only by pack:dir and the pack:*:local scripts, whose artifacts are named
// *-LOCAL and are never distributed). A release build must replace sourceUrl/sourceOffer and drop them from
// "$placeholders" first.
/* global module, require, process, console */
'use strict';

/**
 * Returns the unreplaced placeholder fields (empty = ok). AGPL §6/§13 needs ONE way to get the source: a public
 * https sourceUrl (decision a) or a written sourceOffer (decision b). A field still listed in "$placeholders", or a
 * present value that looks like a placeholder, is always reported (it would be shown in About as-is). An absent or
 * empty field is fine only if the other one is set.
 */
function unreplacedPlaceholders(product) {
  const listed = new Set(Array.isArray(product.$placeholders) ? product.$placeholders : []);
  const fake = (v) => /PLACEHOLDER|example\.invalid/i.test(v);
  const present = (k) => typeof product[k] === 'string' && product[k].trim() !== '';
  const out = new Set();
  for (const k of ['sourceUrl', 'sourceOffer']) if (listed.has(k) || (present(k) && fake(product[k]))) out.add(k);
  if (present('sourceUrl') && !out.has('sourceUrl') && !/^https:\/\/[^\s/]+\/\S+$/.test(product.sourceUrl.trim())) out.add('sourceUrl');
  const ok = (k) => present(k) && !out.has(k);
  if (!ok('sourceUrl') && !ok('sourceOffer')) for (const k of ['sourceUrl', 'sourceOffer']) if (!present(k)) out.add(k);
  return [...out].sort();
}

/** Throws unless placeholders are replaced or env.PA_LOCAL_BUILD === '1'. Returns a warning string for local builds. */
function assertNoPlaceholders(product, env) {
  const bad = unreplacedPlaceholders(product);
  if (bad.length === 0) return null;
  const msg = `unreplaced placeholder(s) in packages/core/src/product.config.json: ${bad.join(', ')}`;
  if (env.PA_LOCAL_BUILD === '1') return `WARNING: LOCAL build (PA_LOCAL_BUILD=1), not for distribution: ${msg}`;
  throw new Error(`${msg}. Replace them before a release build, or use a pack:*:local script (PA_LOCAL_BUILD=1) for a LOCAL build.`);
}

module.exports = { unreplacedPlaceholders, assertNoPlaceholders };

// CLI: `node scripts/check-placeholders.cjs` — the official pack scripts run this first so they refuse before building.
if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const product = require('../../../packages/core/src/product.config.json');
  try { const w = assertNoPlaceholders(product, process.env); if (w) console.warn(w); } catch (e) { console.error(`refusing to package: ${e.message}`); process.exit(1); }
}
