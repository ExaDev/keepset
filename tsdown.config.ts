import { defineConfig } from 'tsdown';

export default defineConfig([
  {
    // One build for both library entries, so the library code and the bundled catalogue they share land in one chunk instead of being copied into each. The main entry imports nothing from src/node/, which keeps Node built-ins out of a browser bundle; `node:` imports in the keepset/node chunk stay external.
    entry: ['src/index.ts', 'src/node/fetch-dataset.ts', 'src/browser/entry.ts'],
    root: 'src',
    format: ['esm'],
    dts: true,
    platform: 'neutral',
    deps: { neverBundle: [/^node:/] },
    clean: true,
  },
  {
    // The `keepset` command. Kept out of src/ and out of dist/ on purpose, and out of the exports map, so it is never an importable subpath. It imports the library through the package's own name rather than bundling it, so the catalogue ships once: Node resolves `keepset` and `keepset/node` from inside the package through its exports map.
    entry: ['cli/keepset.ts'],
    format: ['esm'],
    dts: false,
    platform: 'node',
    outDir: 'dist-cli',
    deps: { neverBundle: ['keepset', 'keepset/node'] },
    clean: true,
  },
]);
