import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import exadev from '@exadev/eslint-config';

export default defineConfig(
  // schemas/ and src/generated/ are build output (see scripts/generate-json-schema.ts and scripts/build-catalogue.ts), not source to lint.
  { ignores: ['dist', 'coverage', 'node_modules', 'reports', 'schemas', 'src/generated'] },
  {
    languageOptions: {
      parserOptions: { project: ['./tsconfig.json', './tsconfig.node.json'], tsconfigRootDir: import.meta.dirname },
    },
  },
  { ...js.configs.recommended, files: ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'] },
  ...exadev,
  {
    // The one reasoned exception to the Object.assign ban, made as a files-scoped override rather than an inline disable: src/define.ts is the schema-attached guard helper, which augments a Zod schema object in place because object spread would drop the prototype's parse/refine methods. The file is isolated so this override reaches exactly that one assign and nothing else.
    files: ['src/define.ts'],
    rules: { 'exadev/no-object-assign': 'off' },
  },
);
