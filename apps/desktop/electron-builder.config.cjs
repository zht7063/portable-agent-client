// Local packaging only (no installer distribution). No publish/upload: `publish: null` and every script passes
// --publish never. Product identity comes from the single product config (placeholders).
const product = require('../../packages/core/src/product.config.json');
const { assertNoPlaceholders } = require('./scripts/check-placeholders.cjs');

// Aegis M6 item 6: refuse to package with unreplaced sourceUrl/sourceOffer unless PA_LOCAL_BUILD=1.
const placeholderWarning = assertNoPlaceholders(product, process.env);
if (placeholderWarning) console.warn(placeholderWarning);

module.exports = {
  appId: product.appId,
  productName: product.productName,
  executableName: product.executableName,
  directories: { app: 'stage', output: 'release' },
  publish: null,
  npmRebuild: false,
  asar: true,
  // pa-key.cjs runs under ELECTRON_RUN_AS_NODE from the userData/bin wrapper; keep it (and the native keyring
  // module on macOS/Windows) outside the asar so plain Node resolution works.
  asarUnpack: ['dist/key-helper/**', 'node_modules/@napi-rs/**'],
  files: [
    'package.json',
    'dist/**',
    'LICENSE', 'NOTICE', 'THIRD-PARTY-LICENSES.md',
    'node_modules/@napi-rs/keyring/**',
    'node_modules/@napi-rs/keyring-darwin-*/**',
    'node_modules/@napi-rs/keyring-win32-*/**',
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
  linux: { target: 'dir', category: 'Development', maintainer: `${product.productName} (placeholder) <noreply@example.invalid>`, synopsis: `${product.productName} desktop client (based on new-api)` },
  deb: { packageCategory: 'devel' },
  artifactName: '${name}-${version}-${os}-${arch}-LOCAL.${ext}',
  // Installers (local, unsigned, never published): `bun run pack:mac` (dmg arm64 + x64, must run on macOS) and
  // `bun run pack:win` (NSIS x64). No signing: mac identity null (ad-hoc on arm64), no Windows certificate.
  mac: { target: 'dir', identity: null, category: 'public.app-category.developer-tools' },
  dmg: { writeUpdateInfo: false },
  win: { target: 'dir', signAndEditExecutable: true, verifyUpdateCodeSignature: false },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowElevation: true,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: product.productName,
    uninstallDisplayName: `${product.productName} (LOCAL build)`,
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
