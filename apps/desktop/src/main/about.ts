import type { AppAboutRes, ProductConfig } from '@pac/core';

/*
 * M6 (plan v2 §5): data for the About & licenses page and menu. AGPL-3.0 §5(a)/§6/§13: the app states that it is a
 * modified version of new-api, keeps the upstream §7(b) attribution verbatim, and offers the Corresponding Source
 * (product config sourceUrl/sourceOffer) for the exact build commit.
 */
export const UPSTREAM_ATTRIBUTION = 'Frontend design and development by New API contributors.';

/** Same-origin license texts copied into the renderer root by scripts/build-new-api-web.sh (licenses/). */
export const LICENSE_FILES: AppAboutRes['licenseFiles'] = [
  { title: 'LICENSE (GNU AGPL-3.0)', path: '/licenses/LICENSE.txt' },
  { title: 'NOTICE', path: '/licenses/NOTICE.txt' },
  { title: 'Third-party licenses', path: '/licenses/THIRD-PARTY-LICENSES.txt' },
  { title: 'new-api LICENSE (AGPL-3.0)', path: '/LICENSE.new-api.txt' },
  { title: 'new-api NOTICE', path: '/NOTICE.new-api.txt' },
  { title: 'Lora font (SIL OFL-1.1)', path: '/licenses/fontsource-variable_lora.LICENSE.txt' },
  { title: 'Public Sans font (SIL OFL-1.1)', path: '/licenses/fontsource-variable_public-sans.LICENSE.txt' },
  { title: 'isbot (Unlicense)', path: '/licenses/isbot.LICENSE.txt' },
  { title: 'text-encoding (Unlicense)', path: '/licenses/text-encoding.LICENSE.txt' },
];

export function buildAbout(o: { product: ProductConfig; compat: { tag: string; commit: string }; version: string; buildCommit: string }): AppAboutRes {
  return {
    productName: o.product.productName,
    version: o.version,
    license: 'AGPL-3.0-only',
    sourceUrl: o.product.sourceUrl,
    sourceOffer: o.product.sourceOffer ?? null,
    buildCommit: o.buildCommit,
    upstream: { ...o.product.upstream, tag: o.compat.tag, commit: o.compat.commit },
    attribution: UPSTREAM_ATTRIBUTION,
    licenseFiles: LICENSE_FILES,
  };
}
