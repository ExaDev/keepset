import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCatalogue, getManifest, listDatasets, type Dataset } from "keepset";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { fixtureIndex, liveEntry } from "../src/test-support/entries";
import { buildSite, type SiteFiles } from "./build-site";

const SITE_URL = "https://example.org/keepset/";

/** The schema.org Dataset shape the pages promise: the properties Google Dataset Search requires (name, description) and those this generator always writes, each in schema.org's expected type. */
const DatasetJsonLdSchema = z.looseObject({
  "@context": z.literal("https://schema.org"),
  "@type": z.literal("Dataset"),
  name: z.string().min(1),
  description: z.string().min(1),
  url: z.url(),
  identifier: z.string().min(1),
  keywords: z.array(z.string().min(1)),
  license: z.url().optional(),
  citation: z.array(z.string().min(1)).optional(),
  isPartOf: z.object({ "@type": z.literal("DataCatalog"), name: z.string(), url: z.url() }),
  distribution: z.array(z.strictObject({ "@type": z.literal("DataDownload"), contentUrl: z.url(), archivedAt: z.url().optional() })).min(1),
});

const directories: string[] = [];
afterAll(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function build(datasets: readonly Dataset[]): SiteFiles {
  const outDir = mkdtempSync(join(tmpdir(), "keepset-site-"));
  directories.push(outDir);

  return buildSite({ datasets, manifest: getManifest(), packageVersion: "9.9.9", siteUrl: SITE_URL, outDir });
}

function jsonLdOf(html: string): unknown {
  const match = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
  if (match?.[1] === undefined) {
    throw new Error("the page has no JSON-LD");
  }

  return JSON.parse(match[1]);
}

function page(files: SiteFiles, path: string): string {
  const text = files.get(path);
  if (text === undefined) {
    throw new Error(`the site has no ${path}`);
  }

  return text;
}

describe("buildSite on a fixture catalogue", () => {
  const catalogue = createCatalogue(fixtureIndex);
  const files = build(catalogue.listDatasets());

  it("writes one entry page per dataset and the listing pages by domain and kind", () => {
    expect([...files.keys()].filter((path) => path.startsWith("datasets/")).sort()).toEqual(["datasets/auth-walled/index.html", "datasets/celegans-metabolic/index.html", "datasets/karate/index.html"]);
    for (const path of ["index.html", "domains/index.html", "domains/social-network/index.html", "kinds/index.html", "kinds/graph/index.html", "manifest.webmanifest", "precache.json"]) {
      expect(files.has(path)).toBe(true);
    }
  });

  it("gives every entry page schema.org Dataset JSON-LD, pointing a dead source at its snapshot", () => {
    const karate = DatasetJsonLdSchema.parse(jsonLdOf(page(files, "datasets/karate/index.html")));
    expect(karate).toMatchObject({ name: "Zachary Karate Club", url: `${SITE_URL}datasets/karate/`, keywords: ["graph", "Social network", "social", "small"], citation: [expect.stringContaining("https://doi.org/10.1086/jar.33.4.3629752") as string] });
    const dead = DatasetJsonLdSchema.parse(jsonLdOf(page(files, "datasets/celegans-metabolic/index.html")));
    expect(dead.license).toBe("https://spdx.org/licenses/CC-BY-4.0.html");
    expect(dead.distribution).toEqual([{ "@type": "DataDownload", contentUrl: "https://web.archive.org/web/20230601/http://example.edu/~lab/data/celegans_metabolic.zip", archivedAt: "https://web.archive.org/web/20230601/http://example.edu/~lab/data/celegans_metabolic.zip" }]);
    expect(dead.description).toBe("C. elegans metabolic network, a graph dataset in the fixture catalogue, normalised to graph/v1.");
  });

  it("links the exact fetch command and renders the recipe and crosswalk as tables", () => {
    const karate = page(files, "datasets/karate/index.html");
    expect(karate).toContain("<code>npx keepset fetch karate</code>");
    expect(karate).toContain('<span data-copy-command="npx keepset fetch karate"></span>');
    expect(karate).toContain("<tr><td>move</td><td><code>nodes[].id</code></td><td><code>nodes[].id</code></td><td>both</td></tr>");
    expect(karate).toContain('<th scope="row">Parser delimiter</th><td><code>&quot;whitespace&quot;</code></td>');
    expect(page(files, "datasets/auth-walled/index.html")).toContain("This entry has no fetchable recipe yet: the source requires an account to download");
  });

  it("writes a search index whose ids are the catalogue's ids", () => {
    const index: unknown = JSON.parse(page(files, "search-index.json"));
    expect(Array.isArray(index) ? index.map((record: unknown) => (typeof record === "object" && record !== null && "id" in record ? record.id : undefined)) : []).toEqual(catalogue.listDatasets().map((dataset) => dataset.entry.id));
  });

  it("escapes catalogue text, so data never becomes markup", () => {
    const hostile = createCatalogue({ ...fixtureIndex, entries: [{ ...liveEntry, name: '<script>alert("x")</script>', description: "a </script> in prose" }] });
    const hostileFiles = build(hostile.listDatasets());
    const text = page(hostileFiles, "datasets/karate/index.html");
    expect(text).not.toContain("<script>alert");
    expect(text).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(DatasetJsonLdSchema.parse(jsonLdOf(text)).description).toBe("a </script> in prose");
  });
});

describe("buildSite on the bundled catalogue", () => {
  const datasets = listDatasets();
  const files = build(datasets);

  it("writes a page per entry whose JSON-LD validates, and a search index with exactly the catalogue's ids", () => {
    const ids = datasets.map((dataset) => dataset.entry.id);
    expect([...files.keys()].filter((path) => path.startsWith("datasets/")).map((path) => path.slice("datasets/".length, -"/index.html".length))).toEqual(ids);
    for (const id of ids) {
      expect(DatasetJsonLdSchema.safeParse(jsonLdOf(page(files, `datasets/${id}/index.html`))).success).toBe(true);
    }
    const index: unknown = JSON.parse(page(files, "search-index.json"));
    expect(z.array(z.looseObject({ id: z.string() })).parse(index).map((record) => record.id)).toEqual(ids);
  });
});
