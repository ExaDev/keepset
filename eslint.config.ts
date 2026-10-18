import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import exadev from '@exadev/eslint-config';

export default defineConfig(
  // schemas/ is generated build output (see scripts/generate-json-schema.ts), not source to lint.
  { ignores: ['dist', 'coverage', 'node_modules', 'reports', 'schemas'] },
  {
    languageOptions: {
      parserOptions: { project: './tsconfig.json', tsconfigRootDir: import.meta.dirname },
    },
  },
  { ...js.configs.recommended, files: ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'] },
  ...exadev,
);
