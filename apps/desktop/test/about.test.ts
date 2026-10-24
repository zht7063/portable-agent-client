import { describe, expect, it } from 'vitest';
import { PRODUCT, findCredentialLeaks } from '@pac/core';
import compat from '../../../compat.json';
import { buildAbout, LICENSE_FILES, UPSTREAM_ATTRIBUTION } from '../src/main/about';
import { createHandlers, dispatch } from '../src/main/ipc/handlers';

describe('M6 about & licenses', () => {
  const about = buildAbout({ product: PRODUCT, compat, version: '0.0.1', buildCommit: 'deadbeef' });
  it('carries AGPL license, verbatim upstream §7(b) attribution, upstream pin and the configured source offer', () => {
    expect(about.license).toBe('AGPL-3.0-only');
    expect(about.attribution).toBe('Frontend design and development by New API contributors.');
    expect(UPSTREAM_ATTRIBUTION).toBe(about.attribution);
    expect(about.upstream).toMatchObject({ name: 'new-api', author: 'QuantumNous', repo: 'https://github.com/QuantumNous/new-api', tag: compat.tag, commit: compat.commit });
    expect(about.sourceUrl).toBe(PRODUCT.sourceUrl);
    expect(about.sourceUrl).toMatch(/^https:\/\//);
    expect(about.buildCommit).toBe('deadbeef');
    expect(LICENSE_FILES.map((f) => f.path)).toEqual(expect.arrayContaining(['/licenses/LICENSE.txt', '/licenses/NOTICE.txt', '/licenses/THIRD-PARTY-LICENSES.txt', '/licenses/fontsource-variable_lora.LICENSE.txt', '/licenses/fontsource-variable_public-sans.LICENSE.txt']));
  });
  it('app:about is served over IPC without credential material', async () => {
    const cfg = { serverUrl: null, insecureTransport: false, clipboardClearSeconds: 30 };
    const h = createHandlers({ getCore: () => { throw new Error('x'); }, getConfig: () => cfg, setConfig: async () => cfg, harness: {} as never, about: () => about });
    const r = await dispatch(h, 'app:about', {});
    expect(r).toEqual({ ok: true, data: about });
    expect(findCredentialLeaks(r)).toEqual([]);
    const none = createHandlers({ getCore: () => { throw new Error('x'); }, getConfig: () => cfg, setConfig: async () => cfg, harness: {} as never });
    expect(await dispatch(none, 'app:about', {})).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
  });
});
