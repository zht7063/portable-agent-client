import { defineConfig } from 'vitest/config';
import base from './vitest.config';

export default defineConfig({
  resolve: base.resolve,
  test: { include: ['test/compat/**/*.compat.test.ts'], testTimeout: 30_000, fileParallelism: false },
});
