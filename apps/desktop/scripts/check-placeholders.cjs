// Aegis M6 item 6: a build must not ship the unreplaced source-offer placeholders (AGPL §6/§13 source offer).
// product.config.json keeps the placeholders for now; any packaging run fails while they are unreplaced unless the
// build is explicitly a LOCAL one (PA_LOCAL_BUILD=1, set only by pack:dir / pack:linux / pack:win / pack:mac, whose artifacts are named
// *-LOCAL and are never distributed). A release build must replace sourceUrl/sourceOffer and drop them from
// "$placeholders" first.
/* global module */
'use strict';

/** Returns the unreplaced placeholder fields (empty = ok). */
function unreplacedPlaceholders(product) {
  const listed = Array.isArray(product.$placeholders) ? product.$placeholders : [];
  const out = new Set(listed.filter((k) => k === 'sourceUrl' || k === 'sourceOffer'));
  for (const k of ['sourceUrl', 'sourceOffer']) {
    const v = product[k];
    if (typeof v !== 'string' || !v.trim() || /PLACEHOLDER|example\.invalid/i.test(v)) out.add(k);
  }
  return [...out].sort();
}

/** Throws unless placeholders are replaced or env.PA_LOCAL_BUILD === '1'. Returns a warning string for local builds. */
function assertNoPlaceholders(product, env) {
  const bad = unreplacedPlaceholders(product);
  if (bad.length === 0) return null;
  const msg = `unreplaced placeholder(s) in packages/core/src/product.config.json: ${bad.join(', ')}`;
  if (env.PA_LOCAL_BUILD === '1') return `WARNING: LOCAL build (PA_LOCAL_BUILD=1), not for distribution: ${msg}`;
  throw new Error(`${msg}. Replace them before a release build, or set PA_LOCAL_BUILD=1 for a local --dir/LOCAL build.`);
}

module.exports = { unreplacedPlaceholders, assertNoPlaceholders };
