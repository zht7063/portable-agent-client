// Local packaging only (no installer distribution). No publish/upload: `publish: null` and every script passes
// --publish never. Product identity comes from the single product config (placeholders).
const product = require('../../packages/core/src/product.config.json');
const { assertNoPlaceholders } = require('./scripts/check-placeholders.cjs');

// Aegis M6 item 6: refuse to package with unreplaced sourceUrl/sourceOffer unless PA_LOCAL_BUILD=1.
const placeholderWarning = assertNoPlaceholders(product, process.env);
if (placeholderWarning) console.warn(placeholderWarning);
const LOCAL = process.env.PA_LOCAL_BUILD === '1';

/** afterPack: ad-hoc sign the macOS .app, LOCAL and official alike (runs before the dmg is built). No-op elsewhere. */
async function adHocSignMac(ctx, run = require('node:child_process').execFileSync) {
  if (ctx.electronPlatformName !== 'darwin') return false;
  const app = require('node:path').join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`);
  run('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', app], { stdio: 'inherit' });
  console.log(`  • ad-hoc signed${LOCAL ? ' (LOCAL)' : ''}  ${app}`);
  return true;
}

/** electron-builder 25 has no electronFuses config key. Flip before signing: fuses alter the binary. */
async function afterPack(ctx, fuses = require('@electron/fuses'), run) {
  const path = require('node:path');
  const mac = ctx.electronPlatformName === 'darwin';
  const binary = mac
    ? path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`, 'Contents', 'MacOS', ctx.packager.appInfo.productFilename)
    : path.join(ctx.appOutDir, product.executableName + (ctx.electronPlatformName === 'win32' ? '.exe' : ''));
  const { flipFuses, FuseVersion, FuseV1Options } = fuses;
  await flipFuses(binary, { version: FuseVersion.V1, [FuseV1Options.RunAsNode]: false });
  return adHocSignMac(ctx, run);
}

module.exports = {
  appId: product.appId,
  productName: product.productName,
  executableName: product.executableName,
  directories: { app: 'stage', output: 'release', buildResources: 'build' },
  // App icon (generated from build/icon-source.jpeg by scripts/gen-icons.py): mac .icns (also the dmg volume icon),
  // Windows .ico (exe + NSIS installer/uninstaller), Linux PNG set.
  publish: null,
  npmRebuild: false,
  asar: true,
  // Native keyring modules on macOS/Windows must stay outside the asar for native loading.
  asarUnpack: ['node_modules/@napi-rs/**'],
  files: [
    'package.json',
    'dist/**',
    'LICENSE', 'NOTICE', 'THIRD-PARTY-LICENSES.md',
    'node_modules/@napi-rs/keyring/**',
    // Only the binary matching the package's arch (${arch} is expanded per target by electron-builder); the stage
    // may hold several (multi-arch dmg build from one stage dir).
    'node_modules/@napi-rs/keyring-darwin-*/**',
    'node_modules/@napi-rs/keyring-win32-*/**',
    '!node_modules/@napi-rs/keyring-darwin-!(${arch})/**',
    '!node_modules/@napi-rs/keyring-win32-!(${arch})-msvc/**',
    // Never ship the Linux keyring binary (bundles libdbus, AFL-2.1 OR GPL-2.0+); Linux uses secret-tool.
    '!node_modules/@napi-rs/keyring-linux-*/**',
  ],
  // M6 (AGPL-3.0): license materials also ship as plain files next to the app (resources/licenses/), not only inside
  // app.asar: our LICENSE/NOTICE/THIRD-PARTY-LICENSES, the new-api LICENSE/NOTICE and the OFL/Unlicense texts of
  // bundled fonts/packages (all produced by scripts/build-new-api-web.sh). Electron/Chromium notices are added by
  // electron-builder itself (LICENSE.electron.txt, LICENSES.chromium.html in the app root).
  extraResources: [
    { from: 'dist/renderer/licenses', to: 'licenses' },
    { from: 'dist/renderer/LICENSE.new-api.txt', to: 'licenses/LICENSE.new-api.txt' },
    { from: 'dist/renderer/NOTICE.new-api.txt', to: 'licenses/NOTICE.new-api.txt' },
  ],
  // Default target is an unpacked dir; `bun run pack:linux` builds AppImage + deb locally (never published).
  linux: { target: 'dir', icon: 'build/icons', category: 'Development', maintainer: `${product.productName} (placeholder) <noreply@example.invalid>`, synopsis: `${product.productName} desktop client (based on new-api)` },
  deb: { packageCategory: 'devel' },
  // LOCAL builds (pack:dir, pack:*:local) are marked in the file name; official ones are not.
  artifactName: `\${name}-\${version}-\${os}-\${arch}${LOCAL ? '-LOCAL' : ''}.\${ext}`,
  // Installers (local, unsigned, never published): `bun run pack:mac` (dmg arm64 + x64, must run on macOS) and
  // `bun run pack:win` (NSIS x64). No Developer ID signing and no Windows certificate (identity null). All mac
  // builds (LOCAL and official) are ad-hoc signed in afterPack (codesign --sign -; electron-builder 25 has no
  // identity '-' support) so the arm64 app is not reported as "damaged". No Developer ID / notarization yet.
  afterPack,
  mac: { target: 'dir', icon: 'build/icon.icns', identity: null, category: 'public.app-category.developer-tools' },
  dmg: { icon: 'build/icon.icns', writeUpdateInfo: false },
  win: { target: 'dir', icon: 'build/icon.ico', signAndEditExecutable: true, verifyUpdateCodeSignature: false },
  nsis: {
    include: 'build/installer.nsh',
    oneClick: false,
    installerIcon: 'build/icon.ico',
    uninstallerIcon: 'build/icon.ico',
    perMachine: false,
    allowElevation: true,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: product.productName,
    uninstallDisplayName: `${product.productName}${LOCAL ? ' (LOCAL build)' : ''}`,
    deleteAppDataOnUninstall: false,
    differentialPackage: false,
    license: '../../LICENSE',
  },
  // Linux host building Linux: use the locally installed Electron (no download), resolved through this package's
  // node_modules (bun's isolated linker does not hoist electron to the repo root). Other target platforms return
  // null, so electron-builder fetches the matching official Electron zip (checksum-verified) into its cache.
  electronDist: (opts) => (opts.platformName === 'linux' && process.platform === 'linux' && opts.arch === process.arch
    ? require('node:path').join(require('node:path').dirname(require.resolve('electron/package.json', { paths: [__dirname] })), 'dist')
    : null),
};
