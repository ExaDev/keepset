/* Builds the static site into site-dist/: `pnpm run site`, after `pnpm build`. The pages are generated from the catalogue the package bundles, read through the package's own exports (`keepset`), so the site and the library can never disagree. The client island and the service worker are bundled with esbuild carrying the vanilla-extract plugin, so the island's `.css.ts` (which also holds the site's global stylesheet) compiles to `app.css` next to `app.js`; the icon is copied from site/static/.

   No try/catch: any failure exits non-zero. */

import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { vanillaExtractPlugin } from "@vanilla-extract/esbuild-plugin";
import { getManifest, listDatasets, listNamespaces } from "keepset";
import { buildSite } from "./build-site";
import { finalisePrecache } from "./precache";

/** Where GitHub Pages publishes the site: the project site of Mearman/keepset. Absolute URLs (canonical links, JSON-LD) are built from it; every link between pages is relative. */
export const SITE_URL = "https://mearman.github.io/keepset/";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const outDir = join(repoRoot, "site-dist");

const packageJson: unknown = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
if (typeof packageJson !== "object" || packageJson === null || !("version" in packageJson) || typeof packageJson.version !== "string") {
  throw new Error("package.json has no string version");
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const files = buildSite({ catalogue: { manifest: getManifest(), listDatasets, listNamespaces }, packageVersion: packageJson.version, siteUrl: SITE_URL, outDir });
copyFileSync(join(here, "static", "icon.svg"), join(outDir, "icon.svg"));
await build({
  entryPoints: { app: join(here, "client/app.tsx"), fetchWorker: join(here, "client/fetch-worker.ts"), sw: join(here, "client/sw.ts") },
  outdir: outDir,
  bundle: true,
  format: "esm",
  platform: "browser",
  jsx: "automatic",
  minify: true,
  splitting: true,
  outExtension: { ".js": ".js" },
  plugins: [vanillaExtractPlugin()],
  // unbzip2-stream, the bzip2 reader the archive layer shares with Node, requires Node's `stream`; readable-stream is the same interface as a package, so the preview worker can read a bzip2 archive in a browser.
  alias: { stream: "readable-stream" },
  loader: { ".svg": "dataurl" },
});
// After the bundle, so the digest the service worker's cache is named for covers app.js and app.css too.
finalisePrecache(outDir);
console.log(`Wrote ${String(files.size)} generated files and the client bundle to site-dist/`);
