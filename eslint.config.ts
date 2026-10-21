import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import exadev from '@exadev/eslint-config';

export default defineConfig(
  /* schemas/ and src/generated/ are build output (see scripts/generate-json-schema.ts and scripts/build-catalogue.ts), not source to lint.
     scripts/seed/sources/ and scripts/seed/fixtures/ are copies of the upstream catalogues the seed import reads, kept in their own key order. */
  { ignores: ['dist', 'dist-cli', 'site-dist', 'coverage', 'node_modules', 'reports', 'schemas', 'src/generated', 'scripts/seed/sources', 'scripts/seed/fixtures'] },
  {
    languageOptions: {
      parserOptions: { project: ['./tsconfig.json', './tsconfig.node.json', './tsconfig.site.json', './tsconfig.sw.json'], tsconfigRootDir: import.meta.dirname },
    },
  },
  { ...js.configs.recommended, files: ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'] },
  ...exadev,
  {
    // The one reasoned exception to the Object.assign ban, made as a files-scoped override rather than an inline disable: src/define.ts is the schema-attached guard helper, which augments a Zod schema object in place because object spread would drop the prototype's parse/refine methods. The file is isolated so this override reaches exactly that one assign and nothing else.
    files: ['src/define.ts'],
    rules: { 'exadev/no-object-assign': 'off' },
  },
  {
    // The package entry points (keepset/node, keepset/browser) are the barrels of their platform surfaces: each composes the neutral fetch core's types with its own ports, which is what a package entry is for. The rule admits only src/index.ts by name and the shared config allows no inline disables.
    files: ['src/node/fetch-dataset.ts', 'src/browser/entry.ts'],
    rules: { 'exadev/barrel-policy': 'off' },
  },
);
