import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const app = join(__dirname, '..');
const built = existsSync(join(app, 'dist', 'main', 'index.cjs')) && existsSync(join(app, 'dist', 'renderer'));
// Loading the config runs the Aegis M6 item-6 placeholder check; these tests inspect a LOCAL config.
process.env.PA_LOCAL_BUILD = '1';

describe('local packaging config (H4)', () => {
  it('never publishes, uses the central product config and never ships @napi-rs/keyring-linux-*', () => {
    expect(existsSync(join(app, 'electron-builder.yml'))).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cfg = require(join(app, 'electron-builder.config.cjs')) as { publish: unknown; files: string[]; asarUnpack: string[]; appId: string; productName: string };
    const product = JSON.parse(readFileSync(join(app, '..', '..', 'packages', 'core', 'src', 'product.config.json'), 'utf8')) as { appId: string; productName: string };
    expect(cfg.publish).toBeNull();
    expect(cfg.files).toContain('!node_modules/@napi-rs/keyring-linux-*/**');
    expect(cfg.asarUnpack).toContain('dist/key-helper/**');
    expect(cfg.appId).toBe(product.appId);
    expect(cfg.productName).toBe(product.productName);
    const pkg = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    for (const s of Object.values(pkg.scripts)) if (s.includes('electron-builder')) expect(s).toContain('--publish never');
    // Packaging scripts build the production (smoke-free) main bundle.
    for (const n of ['pack:dir', 'pack:linux', 'pack:win', 'pack:mac']) expect(pkg.scripts[n]).toContain('build:prod');
  });

  it('installers: unsigned NSIS x64 (custom dir, shortcuts) and dmg arm64+x64, local only', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cfg = require(join(app, 'electron-builder.config.cjs')) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(cfg.mac.identity).toBeNull();
    expect(cfg.nsis).toMatchObject({ oneClick: false, allowToChangeInstallationDirectory: true, createDesktopShortcut: true, createStartMenuShortcut: true });
    expect(cfg.win.certificateFile ?? cfg.win.signtoolOptions ?? cfg.win.azureSignOptions).toBeUndefined();
    const pkg = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['pack:win']).toMatch(/PA_LOCAL_BUILD=1 electron-builder .*--win nsis --x64 --publish never/);
    expect(pkg.scripts['pack:mac']).toMatch(/PA_LOCAL_BUILD=1 electron-builder .*--mac dmg --arm64 --x64 --publish never/);
    // Local Electron only for a native linux build; other targets download the official zip.
    expect(cfg.electronDist({ platformName: 'win32', arch: 'x64' })).toBeNull();
    expect(cfg.electronDist({ platformName: 'darwin', arch: 'arm64' })).toBeNull();
  });

  it('M6: license materials ship as plain files in resources/licenses (and inside the app)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cfg = require(join(app, 'electron-builder.config.cjs')) as { files: string[]; extraResources: { from: string; to: string }[] };
    for (const f of ['LICENSE', 'NOTICE', 'THIRD-PARTY-LICENSES.md']) expect(cfg.files).toContain(f);
    expect(cfg.extraResources).toEqual(expect.arrayContaining([{ from: 'dist/renderer/licenses', to: 'licenses' }]));
    const build = readFileSync(join(app, '..', '..', 'scripts', 'build-new-api-web.sh'), 'utf8');
    for (const f of ['LICENSE.txt', 'NOTICE.txt', 'THIRD-PARTY-LICENSES.txt']) expect(build).toContain(`$OUT/licenses/${f}`);
  });

  it.skipIf(!built)('stage: linux has no native modules; darwin stages only @napi-rs/keyring(+darwin binary)', () => {
    const run = (platform: string) => spawnSync(process.execPath, ['scripts/stage.mjs'], { cwd: app, env: { ...process.env, PA_TARGET_PLATFORM: platform, PA_TARGET_ARCH: 'arm64' }, encoding: 'utf8' });
    const l = run('linux');
    expect(l.status).toBe(0);
    expect(existsSync(join(app, 'stage', 'node_modules'))).toBe(false);
    const d = run('darwin');
    expect(d.status).toBe(0);
    const mods = readdirSync(join(app, 'stage', 'node_modules', '@napi-rs'));
    expect(mods).toContain('keyring');
    expect(mods.some((m) => m.startsWith('keyring-linux'))).toBe(false);
    const sp = JSON.parse(readFileSync(join(app, 'stage', 'package.json'), 'utf8')) as Record<string, unknown>;
    // Declared so electron-builder actually packs the staged native module (it drops undeclared node_modules).
    expect(Object.keys(sp.dependencies as Record<string, string>).sort()).toEqual(mods.map((m) => `@napi-rs/${m}`).sort());
    expect(sp.main).toBe('dist/main/index.cjs');
    run('linux');
  });

  it('production main bundle has no smoke code; the dev bundle keeps it', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pa-build-'));
    try {
      const b = (prod: boolean, d: string) => spawnSync(process.execPath, ['scripts/build-main.mjs', ...(prod ? ['--prod'] : [])], { cwd: app, env: { ...process.env, PA_OUT_DIR: join(tmp, d) }, encoding: 'utf8' });
      expect(b(true, 'prod').status).toBe(0);
      expect(b(false, 'dev').status).toBe(0);
      const prod = readFileSync(join(tmp, 'prod', 'main', 'index.cjs'), 'utf8');
      const dev = readFileSync(join(tmp, 'dev', 'main', 'index.cjs'), 'utf8');
      for (const m of ['PA_SMOKE', 'runLoginSmoke', 'runUiSmokeStep', 'runKeysSmokeStep', 'PA_USER_DATA']) expect(prod).not.toContain(m);
      expect(prod).toContain('[pac] renderer loaded');
      for (const m of ['PA_SMOKE', 'runLoginSmoke', 'runUiSmokeStep', 'runKeysSmokeStep']) expect(dev).toContain(m);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }, 60000);
});
