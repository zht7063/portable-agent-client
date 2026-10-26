/*
 * M7 surface snapshots. These fail when the attack surface grows: a new preload function, IPC channel, proxy
 * allowlist rule or deny rule must be added here deliberately (and reviewed) -- they are not auto-updated snapshots.
 */
import { describe, expect, it, vi } from 'vitest';
import { BRIDGE_CHANNELS, INVOKE_CHANNELS } from '@pac/core/contract';
import { createBridge } from '../../src/preload/bridge';
import { DENY, RULES, decide } from '../../src/main/proxy/allowlist';
import { ADMIN_SECRET_PATHS, USER_SAVE_PATHS } from '../../src/main/proxy/api-proxy';
import { SERVER_PATH } from '../../src/main/app-protocol';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const shape = (o: unknown, pre = ''): string[] =>
  Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => (typeof v === 'function' ? [`${pre}${k}()`] : v && typeof v === 'object' ? shape(v, `${pre}${k}.`) : [`${pre}${k}=${typeof v}`]));

describe('preload surface', () => {
  it('window.pa exposes exactly these functions (no generic invoke/send/on, no values)', () => {
    const b = createBridge({ invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() });
    expect(shape(b).sort()).toEqual([
      'app.about()',
      'config.get()', 'config.set()',
      'harness.apply()', 'harness.detect()', 'harness.history()', 'harness.keyringStatus()', 'harness.listProfiles()',
      'harness.plan()', 'harness.probeChannel()', 'harness.rollback()', 'harness.rollbackPreview()', 'harness.upsertProfile()',
      'keys.copy()', 'keys.list()', 'keys.remove()', 'keys.show()', 'keys.store()',
      'onSessionChanged()',
      'onShopHost()',
      'server.status()',
      'shop.control()',
    ]);
  });
  it('IPC invoke channels and bridge mapping are exactly these', () => {
    expect([...INVOKE_CHANNELS].sort()).toEqual([
      'app:about', 'config:get', 'config:set', 'harness:apply', 'harness:channel:probe', 'harness:detect', 'harness:history',
      'harness:keyring:status', 'harness:plan', 'harness:profile:list', 'harness:profile:upsert', 'harness:rollback',
      'harness:rollback:preview', 'keys:copy', 'keys:delete', 'keys:list', 'keys:show', 'keys:store', 'server:status', 'shop:control',
    ]);
    expect(Object.keys(BRIDGE_CHANNELS).length).toBe(INVOKE_CHANNELS.length);
  });
  it('preload entry only exposes the bridge under window.pa', () => {
    const src = readFileSync(join(__dirname, '../../src/preload/index.ts'), 'utf8');
    expect(src.match(/exposeInMainWorld\(/g)?.length).toBe(1);
    expect(src).toMatch(/exposeInMainWorld\('pa', createBridge\(ipcRenderer\)\)/);
  });
});

describe('proxy allowlist snapshot', () => {
  it('allow rules', () => {
    expect(RULES.map((r) => `${r.methods.join(',')} ${r.re.source}`)).toEqual([
      'GET,HEAD,POST,PUT,PATCH,DELETE ^\\/api\\/(user|token|channel|log|usage|redemption|option|group|prefill_group|models|vendors|subscription|custom\\-oauth\\-provider|perf\\-metrics|performance|ratio_sync|plugin|task_plugin_options|system\\-task|system\\-info|data|mj|task|deployments|audit|setup|verify|verification|oauth)(\\/|$)',
      'GET,HEAD ^\\/api\\/(status|about|notice|home_page_content|pricing|privacy\\-policy|user\\-agreement|rankings|ratio_config|uptime|midjourney|reset_password)(\\/|$)',
      'POST ^\\/pg\\/(chat\\/completions|images\\/generations|responses)$',
    ]);
  });
  it('deny rules (checked first)', () => {
    expect(DENY.map((d) => `${d.code} ${d.re.source}`)).toEqual([
      'OAUTH_UNSUPPORTED ^\\/api\\/oauth\\/(?!email\\/)',
      'FORBIDDEN ^\\/api\\/(creem|stripe|waffo|waffo-pancake)\\/webhook(\\/|$)',
      'PASSKEY_UNSUPPORTED ^\\/api\\/user\\/(login\\/passkey|passkey\\/login)\\/',
      'FORBIDDEN ^\\/api\\/user\\/epay\\/notify$',
      'FORBIDDEN ^\\/api\\/subscription\\/epay\\/(notify|return)$',
    ]);
  });
  it('server paths, masked-save paths', () => {
    expect(SERVER_PATH.source).toBe('^\\/(api|v1|mj|pg)(\\/|$)');
    expect(ADMIN_SECRET_PATHS.source).toBe('^\\/api\\/(channel|option|custom-oauth-provider|deployments|user\\/setting)(\\/|$)');
    expect(USER_SAVE_PATHS.source).toBe('^\\/api\\/user(\\/self)?\\/?$');
  });
  it('relay endpoints that take API keys are never reachable from the renderer', () => {
    for (const m of ['GET', 'POST', 'PUT', 'DELETE'])
      for (const p of ['/v1/chat/completions', '/v1/models', '/v1/responses', '/v1beta/models', '/mj/submit/imagine', '/suno/submit', '/kling/v1/videos', '/pg/models', '/dashboard/billing/usage'])
        expect(decide(m, p).allow, `${m} ${p}`).toBe(false);
  });
});
