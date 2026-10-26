import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from '../../../test/helpers/subprocess';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
    expect(cfg.asarUnpack).not.toContain('dist/key-helper/**');
    expect(cfg).not.toHaveProperty('electronFuses');
    expect(cfg.appId).toBe(product.appId);
    expect(cfg.productName).toBe(product.productName);
    const pkg = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    for (const s of Object.values(pkg.scripts)) if (s.includes('electron-builder')) expect(s).toContain('--publish never');
    // Packaging scripts build the production (smoke-free) main bundle.
    for (const n of ['pack:dir', 'pack:linux', 'pack:win', 'pack:mac']) expect(pkg.scripts[n]).toContain('build:prod');
  });

  it('installers: unsigned NSIS x64 (custom dir, shortcuts) and dmg arm64+x64 (LOCAL ad-hoc signed), local only', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cfg = require(join(app, 'electron-builder.config.cjs')) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(cfg.mac.identity).toBeNull(); // no Developer ID; all mac builds are ad-hoc signed in afterPack
    const calls: unknown[][] = [];
    const ctx = (plat: string) => ({ electronPlatformName: plat, appOutDir: '/out/mac-arm64', packager: { appInfo: { productFilename: 'portable-agent' } } });
    const fake = (...a: unknown[]) => { calls.push(a); };
    const fuses = { FuseVersion: { V1: '1' }, FuseV1Options: { RunAsNode: 0 }, flipFuses: vi.fn(async () => { calls.push(['flip']); }) };
    expect(await cfg.afterPack(ctx('darwin'), fuses, fake)).toBe(true);
    expect(calls.map((c) => c[0])).toEqual(['flip', 'codesign']);
    calls.shift();
    expect(calls).toEqual([['codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', '/out/mac-arm64/portable-agent.app'], { stdio: 'inherit' }]]);
    expect(cfg.nsis).toMatchObject({ oneClick: false, allowToChangeInstallationDirectory: true, createDesktopShortcut: true, createStartMenuShortcut: true });
    expect(cfg.win.certificateFile ?? cfg.win.signtoolOptions ?? cfg.win.azureSignOptions).toBeUndefined();
    const pkg = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['pack:win:local']).toMatch(/PA_LOCAL_BUILD=1 electron-builder .*--win nsis --x64 --publish never/);
    expect(pkg.scripts['pack:mac:local']).toMatch(/PA_LOCAL_BUILD=1 electron-builder .*--mac dmg --arm64 --publish never && .*PA_TARGET_ARCH=x64 node scripts\/stage\.mjs && PA_LOCAL_BUILD=1 electron-builder .*--mac dmg --x64 --publish never/);
    // Per-arch packages carry only their own keyring binary (defense in depth; pack:mac stages each arch separately).
    expect(cfg.files).toEqual(expect.arrayContaining(['!node_modules/@napi-rs/keyring-darwin-!(${arch})/**', '!node_modules/@napi-rs/keyring-win32-!(${arch})-msvc/**']));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Minimatch } = require(require.resolve('minimatch', { paths: [require.resolve('app-builder-lib', { paths: [require.resolve('electron-builder', { paths: [app] })] })] })) as { Minimatch: new (p: string) => { match: (s: string) => boolean } };
    const excl = (a: string) => new Minimatch('node_modules/@napi-rs/keyring-darwin-!(${arch})/**'.replace('${arch}', a));
    expect(excl('arm64').match('node_modules/@napi-rs/keyring-darwin-x64/keyring.darwin-x64.node')).toBe(true);
    expect(excl('arm64').match('node_modules/@napi-rs/keyring-darwin-arm64/keyring.darwin-arm64.node')).toBe(false);
    expect(excl('x64').match('node_modules/@napi-rs/keyring-darwin-arm64/keyring.darwin-arm64.node')).toBe(true);
    expect(excl('x64').match('node_modules/@napi-rs/keyring-darwin-x64/keyring.darwin-x64.node')).toBe(false);
    // Local Electron only for a native linux build; other targets download the official zip.
    expect(cfg.electronDist({ platformName: 'win32', arch: 'x64' })).toBeNull();
    expect(cfg.electronDist({ platformName: 'darwin', arch: 'arm64' })).toBeNull();
  });

  it('afterPack disables RunAsNode for each platform and propagates fuse failures before signing', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cfg = require(join(app, 'electron-builder.config.cjs'));
    const product = JSON.parse(readFileSync(join(app, '../../packages/core/src/product.config.json'), 'utf8'));
    const flipFuses = vi.fn().mockResolvedValue(undefined);
    const fuses = { FuseVersion: { V1: '1' }, FuseV1Options: { RunAsNode: 0 }, flipFuses };
    const run = vi.fn();
    const ctx = (platform: string) => ({ electronPlatformName: platform, appOutDir: '/out', packager: { appInfo: { productFilename: 'My App' } } });
    for (const [platform, binary] of [
      ['darwin', '/out/My App.app/Contents/MacOS/My App'],
      ['win32', `/out/${product.executableName}.exe`],
      ['linux', `/out/${product.executableName}`],
    ] as const) {
      await cfg.afterPack(ctx(platform), fuses, run);
      expect(flipFuses).toHaveBeenLastCalledWith(binary, { version: '1', 0: false });
    }
    expect(run).toHaveBeenCalledTimes(1);
    run.mockClear();
    flipFuses.mockRejectedValueOnce(new Error('fuse failure'));
    await expect(cfg.afterPack(ctx('darwin'), fuses, run)).rejects.toThrow('fuse failure');
    expect(run).not.toHaveBeenCalled();
  });

  it('M6: license materials ship as plain files in resources/licenses (and inside the app)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cfg = require(join(app, 'electron-builder.config.cjs')) as { files: string[]; extraResources: { from: string; to: string }[] };
    for (const f of ['LICENSE', 'NOTICE', 'THIRD-PARTY-LICENSES.md']) expect(cfg.files).toContain(f);
    expect(cfg.extraResources).toEqual(expect.arrayContaining([{ from: 'dist/renderer/licenses', to: 'licenses' }]));
    const build = readFileSync(join(app, '..', '..', 'scripts', 'build-new-api-web.sh'), 'utf8');
    for (const f of ['LICENSE.txt', 'NOTICE.txt', 'THIRD-PARTY-LICENSES.txt']) expect(build).toContain(`$OUT/licenses/${f}`);
  });

  it.skipIf(!built)('stage is dependency-free on all supported platforms', () => {
    for (const platform of ['linux', 'darwin', 'win32']) {
      const r = spawnSync(process.execPath, ['scripts/stage.mjs'], { cwd: app, env: { ...process.env, PA_TARGET_PLATFORM: platform, PA_TARGET_ARCH: 'x64' }, encoding: 'utf8' });
      expect(r.status).toBe(0);
      expect(existsSync(join(app, 'stage/node_modules'))).toBe(false);
      const staged = JSON.parse(readFileSync(join(app, 'stage/package.json'), 'utf8')) as { main: string; dependencies?: object };
      expect(staged.main).toBe('dist/main/index.cjs'); expect(staged.dependencies).toBeUndefined();
    }
  });

  it('build-main: PA_BUILD_COMMIT cannot hide a different HEAD (prod fails) or a dirty tree (-dirty suffix)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pa-commit-'));
    try {
      const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: app, encoding: 'utf8' }).stdout.trim();
      const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: app, encoding: 'utf8' }).stdout.trim() !== '';
      const b = (commit: string, prod: boolean, d: string) => spawnSync(process.execPath, ['scripts/build-main.mjs', ...(prod ? ['--prod'] : [])], { cwd: app, env: { ...process.env, PA_OUT_DIR: join(tmp, d), PA_BUILD_COMMIT: commit }, encoding: 'utf8' });
      const wrong = b('f'.repeat(40), true, 'wrong');
      expect(wrong.status).toBe(1);
      expect(wrong.stderr).toContain('does not match git HEAD');
      expect(b('f'.repeat(40), false, 'wrongdev').status).toBe(0); // dev build only warns
      expect(b(head, true, 'ok').status).toBe(0);
      const main = readFileSync(join(tmp, 'ok', 'main', 'index.cjs'), 'utf8');
      expect(main).toContain(JSON.stringify(head + (dirty ? '-dirty' : '')).slice(0, -1));
      if (dirty) expect(main).toContain(`${head}-dirty`);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
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
