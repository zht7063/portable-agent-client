import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['.shop-poc-main.js', '**/dist/**', '**/node_modules/**', '**/stage/**', '**/release/**', 'vendor/**', '.build/**', '**/*.config.*', '**/*.config.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
