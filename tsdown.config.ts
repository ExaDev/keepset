import { defineConfig } from 'tsdown';

export default defineConfig({
  // One build for both entries, so the library code and the bundled catalogue they share land in one chunk instead of being copied into each. The main entry imports nothing from src/node/, which keeps Node built-ins out of a browser bundle; `node:` imports in the keepset/node chunk stay external.
  entry: ['src/index.ts', 'src/node/fetch-dataset.ts'],
  root: 'src',
  format: ['esm'],
  dts: true,
  platform: 'neutral',
  deps: { neverBundle: [/^node:/] },
  clean: true,
});
