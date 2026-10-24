import { describe, expect, it, vi } from 'vitest';
import { createHandlers, dispatch } from '../src/main/ipc/handlers';
import { smokeAutoConfirmReveal } from '../src/main/smoke-gate';

const mk = (confirm?: () => Promise<boolean>) => {
  const cfg = { serverUrl: null as string | null, insecureTransport: false, clipboardClearSeconds: 30 };
  const setConfig = vi.fn(async (p: { clipboardClearSeconds?: number }) => Object.assign(cfg, p));
  const h = createHandlers({ getCore: () => { throw new Error('x'); }, getConfig: () => cfg, setConfig: setConfig as never, harness: {} as never, ...(confirm ? { confirmDisableClipboardClear: confirm } : {}) });
  return { h, cfg, setConfig };
};

describe('Aegis M5: disabling clipboard auto-clear needs native confirmation', () => {
  it('refused when no dialog is available', async () => {
    const t = mk();
    expect(await dispatch(t.h, 'config:set', { clipboardClearSeconds: 0 })).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    expect(t.setConfig).not.toHaveBeenCalled();
  });
  it('cancel (the default) saves nothing; confirm saves', async () => {
    const no = mk(async () => false);
    expect(await dispatch(no.h, 'config:set', { clipboardClearSeconds: 0 })).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    expect(no.setConfig).not.toHaveBeenCalled();
    const c = vi.fn(async () => true); const yes = mk(c);
    expect(await dispatch(yes.h, 'config:set', { clipboardClearSeconds: 0 })).toMatchObject({ ok: true });
    expect(c).toHaveBeenCalledTimes(1);
    expect(yes.cfg.clipboardClearSeconds).toBe(0);
    // Already off: no second prompt.
    expect(await dispatch(yes.h, 'config:set', { clipboardClearSeconds: 0 })).toMatchObject({ ok: true });
    expect(c).toHaveBeenCalledTimes(1);
  });
  it('non-zero durations need no confirmation', async () => {
    const c = vi.fn(async () => false); const t = mk(c);
    expect(await dispatch(t.h, 'config:set', { clipboardClearSeconds: 60 })).toMatchObject({ ok: true });
    expect(c).not.toHaveBeenCalled();
  });
});

describe('Aegis M5: Show-key smoke auto-confirm gate', () => {
  const env = { PA_SMOKE: '1', PA_SMOKE_UI: '1' };
  it('only in a smoke build, unpackaged, with PA_SMOKE=1 and PA_SMOKE_UI=1', () => {
    expect(smokeAutoConfirmReveal({ smokeBuild: true, isPackaged: false, env })).toBe(true);
    expect(smokeAutoConfirmReveal({ smokeBuild: true, isPackaged: true, env })).toBe(false);
    expect(smokeAutoConfirmReveal({ smokeBuild: false, isPackaged: false, env })).toBe(false);
    expect(smokeAutoConfirmReveal({ smokeBuild: true, isPackaged: false, env: { PA_SMOKE: '1' } })).toBe(false);
    expect(smokeAutoConfirmReveal({ smokeBuild: true, isPackaged: false, env: {} })).toBe(false);
  });
});
