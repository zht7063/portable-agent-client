import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const src = (p: string) => fileURLToPath(new URL(`./packages/${p}`, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against package sources (no build step needed).
    alias: [
      { find: /^@pac\/core\/contract$/, replacement: src('core/src/contract/index.ts') },
      { find: /^@pac\/core\/product$/, replacement: src('core/src/product.ts') },
      { find: /^@pac\/core\/fs$/, replacement: src('core/src/fs/index.ts') },
      { find: /^@pac\/core$/, replacement: src('core/src/index.ts') },
      { find: /^@pac\/harness$/, replacement: src('harness/src/index.ts') },
      { find: /^@pac\/keychain$/, replacement: src('keychain/src/index.ts') },
    ],
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'test/live/**', 'vendor/**', '.build/**'],
  },
});
