/* Builds the static site into site-dist/: `pnpm run site`, after `pnpm build`. The pages are generated from the catalogue the package bundles, read through the package's own exports (`keepset`), so the site and the library can never disagree. The client island and the service worker are bundled from site/client/ with tsdown; styles and the icon are copied from site/static/.

   No try/catch: any failure exits non-zero. */

import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getManifest, listDatasets } from "keepset";
import { build } from "tsdown";
import { buildSite } from "./build-site";

/** Where GitHub Pages publishes the site: the project site of ExaDev/keepset. Absolute URLs (canonical links, JSON-LD) are built from it; every link between pages is relative. */
export const SITE_URL = "https://exadev.github.io/keepset/";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const outDir = join(repoRoot, "site-dist");

const packageJson: unknown = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
if (typeof packageJson !== "object" || packageJson === null || !("version" in packageJson) || typeof packageJson.version !== "string") {
  throw new Error("package.json has no string version");
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const files = buildSite({ datasets: listDatasets(), manifest: getManifest(), packageVersion: packageJson.version, siteUrl: SITE_URL, outDir });
for (const asset of ["styles.css", "icon.svg"]) {
  copyFileSync(join(here, "static", asset), join(outDir, asset));
}
await build({
  entry: { app: join(here, "client/app.ts"), sw: join(here, "client/sw.ts") },
  outDir,
  format: ["esm"],
  platform: "browser",
  dts: false,
  minify: true,
  clean: false,
  config: false,
  outExtensions: () => ({ js: ".js" }),
});
console.log(`Wrote ${String(files.size)} generated files and the client bundle to site-dist/`);
