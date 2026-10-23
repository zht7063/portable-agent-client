// Local packaging only (no installer distribution). No publish/upload: `publish: null` and every script passes
// --publish never. Product identity comes from the single product config (placeholders).
const product = require('../../packages/core/src/product.config.json');

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
  linux: { target: 'dir', category: 'Development' },
  mac: { target: 'dir', identity: null },
  win: { target: 'dir' },
  // Use the locally installed Electron; no download.
  // Resolved through this package's node_modules (bun's isolated linker does not hoist electron to the repo root).
  electronDist: require('node:path').join(require('node:path').dirname(require.resolve('electron/package.json', { paths: [__dirname] })), 'dist'),
};
