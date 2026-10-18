import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Dataset, Manifest } from "keepset";
import { slug } from "./html";
import { entryPage, groupsPage, homePage, listingPage, type PageContext } from "./pages";

/** One row of the search index the client island loads: enough to filter and label a result without fetching its page. */
export interface SearchRecord {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly domain?: string;
  readonly kind: string;
  readonly tags: readonly string[];
  readonly fetchable: boolean;
}

/** What the generator is given: the catalogue's datasets and manifest (from the package, never a parallel copy), the package version, the published root URL and the output directory. */
export interface SiteOptions {
  readonly datasets: readonly Dataset[];
  readonly manifest: Manifest;
  readonly packageVersion: string;
  readonly siteUrl: string;
  readonly outDir: string;
}

/** The files a build wrote, by path relative to the output directory, so a caller (the service worker's precache list, a test) can see exactly what the site holds. */
export type SiteFiles = ReadonlyMap<string, string>;

/**
 * Groups datasets by a label, refusing two labels that share a slug, since they would share a listing page.
 * @param datasets - The datasets.
 * @param labelOf - Each dataset's label, or undefined for none.
 * @returns The groups in label order.
 */
function groupBy(datasets: readonly Dataset[], labelOf: (dataset: Dataset) => string | undefined): { label: string; datasets: Dataset[] }[] {
  const groups = new Map<string, Dataset[]>();
  for (const dataset of datasets) {
    const label = labelOf(dataset);
    if (label !== undefined) {
      groups.set(label, [...(groups.get(label) ?? []), dataset]);
    }
  }
  const slugs = new Map<string, string>();
  for (const label of groups.keys()) {
    const key = slug(label);
    const clash = slugs.get(key);
    if (key === "" || clash !== undefined) {
      throw new Error(`the label ${JSON.stringify(label)} has no listing page of its own: its slug ${JSON.stringify(key)} is empty or shared with ${JSON.stringify(clash)}`);
    }
    slugs.set(key, label);
  }

  return [...groups].sort(([left], [right]) => (left < right ? -1 : 1)).map(([label, members]) => ({ label, datasets: members }));
}

/**
 * Generates the static site's pages and data: the home page, one page per entry, listing pages by domain and by kind with their indexes, the search index, the web app manifest and the service worker's precache manifest. Static assets and the client bundle are added by the caller.
 * @param options - The catalogue, versions, URL and output directory.
 * @returns Every file written, by relative path.
 */
export function buildSite(options: SiteOptions): SiteFiles {
  const { datasets, manifest, packageVersion, siteUrl } = options;
  const files = new Map<string, string>();
  const context = (root: string): PageContext => ({ siteUrl, manifest, packageVersion, root });

  files.set("index.html", homePage(context(""), datasets));
  for (const dataset of datasets) {
    files.set(`datasets/${dataset.entry.id}/index.html`, entryPage(context("../../"), dataset));
  }
  for (const [title, directory, groups] of [
    ["Domains", "domains", groupBy(datasets, (dataset) => dataset.entry.domain)],
    ["Kinds", "kinds", groupBy(datasets, (dataset) => dataset.kind)],
  ] as const) {
    files.set(`${directory}/index.html`, groupsPage(context("../"), title, groups.map((group) => ({ label: group.label, count: group.datasets.length }))));
    for (const group of groups) {
      files.set(`${directory}/${slug(group.label)}/index.html`, listingPage(context("../../"), `${title.slice(0, -1)}: ${group.label}`, group.datasets));
    }
  }

  const search: SearchRecord[] = datasets.map(({ entry, kind }) => ({
    id: entry.id,
    name: entry.name,
    ...(entry.description === undefined ? {} : { description: entry.description }),
    ...(entry.domain === undefined ? {} : { domain: entry.domain }),
    kind,
    tags: entry.tags,
    fetchable: entry.recipe.status === "fetchable",
  }));
  files.set("search-index.json", JSON.stringify(search));
  files.set(
    "manifest.webmanifest",
    JSON.stringify({ name: "keepset", short_name: "keepset", description: manifest.description, start_url: "./", scope: "./", display: "standalone", background_color: "#ffffff", theme_color: "#1f4e79", icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml" }] }, undefined, 2),
  );
  // The service worker precaches the shell and every listing page, and caches entry pages as they are visited: the entry pages together are most of the site, too much to download on a first visit.
  const shell = ["./", "app.css", "app.js", "icon.svg", "manifest.webmanifest", "search-index.json", ...[...files.keys()].filter((path) => path.startsWith("domains/") || path.startsWith("kinds/")).map((path) => path.replace(/index\.html$/, ""))];
  files.set("precache.json", JSON.stringify({ version: `${packageVersion}+${manifest.id}@${manifest.version}`, urls: shell }));

  for (const [path, text] of files) {
    const target = join(options.outDir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text, "utf8");
  }

  return files;
}
