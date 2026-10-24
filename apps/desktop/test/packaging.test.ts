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

  it('installers: unsigned NSIS x64 (custom dir, shortcuts) and dmg arm64+x64 (LOCAL ad-hoc signed), local only', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cfg = require(join(app, 'electron-builder.config.cjs')) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(cfg.mac.identity).toBeNull(); // no Developer ID; LOCAL builds are ad-hoc signed in afterPack
    const calls: unknown[][] = [];
    const ctx = (plat: string) => ({ electronPlatformName: plat, appOutDir: '/out/mac-arm64', packager: { appInfo: { productFilename: 'portable-agent' } } });
    const fake = (...a: unknown[]) => { calls.push(a); };
    expect(await cfg.afterPack(ctx('darwin'), fake)).toBe(process.env.PA_LOCAL_BUILD === '1');
    expect(await cfg.afterPack(ctx('win32'), fake)).toBe(false);
    if (process.env.PA_LOCAL_BUILD === '1') expect(calls).toEqual([['codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', '/out/mac-arm64/portable-agent.app'], { stdio: 'inherit' }]]);
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

  it('M6: license materials ship as plain files in resources/licenses (and inside the app)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cfg = require(join(app, 'electron-builder.config.cjs')) as { files: string[]; extraResources: { from: string; to: string }[] };
    for (const f of ['LICENSE', 'NOTICE', 'THIRD-PARTY-LICENSES.md']) expect(cfg.files).toContain(f);
    expect(cfg.extraResources).toEqual(expect.arrayContaining([{ from: 'dist/renderer/licenses', to: 'licenses' }]));
    const build = readFileSync(join(app, '..', '..', 'scripts', 'build-new-api-web.sh'), 'utf8');
    for (const f of ['LICENSE.txt', 'NOTICE.txt', 'THIRD-PARTY-LICENSES.txt']) expect(build).toContain(`$OUT/licenses/${f}`);
  });

  it.skipIf(!built)('stage: linux has no native modules; darwin stages only @napi-rs/keyring(+darwin binary)', () => {
    const run = (platform: string, arch = 'arm64') => spawnSync(process.execPath, ['scripts/stage.mjs'], { cwd: app, env: { ...process.env, PA_TARGET_PLATFORM: platform, PA_TARGET_ARCH: arch }, encoding: 'utf8' });
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
    // Aegis round 3 item 5: one arch per stage, so the declared deps match the bundled arch exactly.
    for (const a of ['arm64', 'x64']) {
      expect(run('darwin', a).status).toBe(0);
      const deps = Object.keys((JSON.parse(readFileSync(join(app, 'stage', 'package.json'), 'utf8')) as { dependencies: Record<string, string> }).dependencies);
      expect(deps.filter((k) => /keyring-darwin-/.test(k) && k !== `@napi-rs/keyring-darwin-${a}`)).toEqual([]);
      expect(readdirSync(join(app, 'stage', 'node_modules', '@napi-rs')).filter((m) => /^keyring-darwin-/.test(m) && m !== `keyring-darwin-${a}`)).toEqual([]);
    }
    const multi = run('darwin', 'arm64,x64');
    expect(multi.status).not.toBe(0);
    expect(multi.stderr).toContain('single arch');
    run('linux');
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
