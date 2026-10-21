import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCrosswalk, type Crosswalk } from "crossmap";
import { describe, expect, it } from "vitest";
import { getDataset, listDatasets } from "../bundled";
import { createCatalogue, type Dataset } from "../catalogue";
import { parseEntry } from "../entry";
import { CatalogueSyntaxError } from "../errors";
import { gzip, tar, zip } from "../test-support/archives";
import { fixtureManifest } from "../test-support/entries";
import { DBLP_LINKS, DBLP_NODES, HETIONET, KINSHIP_TEST, KINSHIP_TRAIN, KINSHIP_VALID, LASTFM, WIKIKG2_TRAIN } from "../test-support/excerpts";
import { fetchEntry, roundTripEntry, type FetchPort } from "./fetch-dataset";

/** The crosswalk files the catalogue ships for these parsers, read from where they are committed. */
const CROSSWALK_DIR = join(import.meta.dirname, "../../catalogue/crosswalks/graph-v1");
const CROSSWALK_FILES = ["relations", "relations-split", "typed", "typed-weighted"] as const;
const crosswalkFiles: Record<string, Crosswalk> = Object.fromEntries(CROSSWALK_FILES.map((name) => [`crosswalks/graph-v1/${name}.json`, parseCrosswalk(JSON.parse(readFileSync(join(CROSSWALK_DIR, `${name}.json`), "utf8")))]));

const URL_OF_SOURCE = "https://example.org/data/graph";

/** An entry document with one live source, the given recipe and crosswalk file. */
const entryFor = (recipe: unknown, crosswalk: string): Record<string, unknown> => ({ id: "graph", name: "Graph", tags: [], category: "graph/v1", sources: [{ url: URL_OF_SOURCE, retrieved: "2026-10-21", status: "live" }], licence: { kind: "unrecorded" }, citations: [], recipe, crosswalk: { file: `crosswalks/graph-v1/${crosswalk}.json` }, expectedCounts: {}, properties: {} });

/** The dataset of that entry. */
function datasetFor(recipe: unknown, crosswalk: string): Dataset {
  return createCatalogue({ manifest: fixtureManifest, crosswalks: crosswalkFiles, entries: [entryFor(recipe, crosswalk)] }).listDatasets()[0] ?? expect.unreachable("the catalogue lists its one entry");
}

const serving = (body: Uint8Array | string): FetchPort => async () => Promise.resolve(new Response(body));

const TRIPLES = { format: "kg-triples", encoding: "utf-8", delimiter: "tab", order: "head-relation-tail", header: "none", quoted: false } as const;

/** A parts archive of the three splits, each `<prefix><split>.txt`. */
const splitParts = (prefix: string): unknown[] => ["train", "valid", "test"].map((name) => ({ name, member: { path: `${prefix}${name}.txt` } }));

const DBLP_TYPES = {
  nodeTypes: ["author", "paper", "term", "venue"],
  linkTypes: [
    { name: "author-paper", source: "author", target: "paper" },
    { name: "paper-term", source: "paper", target: "term" },
    { name: "paper-venue", source: "paper", target: "venue" },
    { name: "paper-author", source: "paper", target: "author" },
    { name: "term-paper", source: "term", target: "paper" },
    { name: "venue-paper", source: "venue", target: "paper" },
  ],
};

const HGB_PARTS = [
  { name: "nodes", member: { path: "DBLP/node.dat" } },
  { name: "links", member: { path: "DBLP/link.dat" } },
];

/** An HGB download as the benchmark serves it: a zip of the dataset's directory, with its info and label files and macOS resource forks beside the two the recipe reads. */
const dblpDownload = zip([
  { path: "DBLP/link.dat", text: DBLP_LINKS },
  { path: "__MACOSX/DBLP/._link.dat", text: "resource fork" },
  { path: "DBLP/info.dat", text: '{"node.dat": {}}' },
  { path: "DBLP/label.dat", text: "262\tJonathan Amsterdam\t0\t1\n" },
  { path: "DBLP/node.dat", text: DBLP_NODES },
]);

describe("a triples recipe", () => {
  it("reads the splits of a tar.gz into one graph whose edges carry their relation and split, and the round trip holds", async () => {
    const dataset = datasetFor({ status: "fetchable", source: 0, archive: { kind: "tar.gz", parts: splitParts("") }, parser: TRIPLES }, "relations-split");
    const download = gzip(
      tar([
        { path: "valid.txt", text: KINSHIP_VALID },
        { path: "train.txt", text: KINSHIP_TRAIN },
        { path: "test.txt", text: KINSHIP_TEST },
      ]),
    );
    const { data, provenance } = await fetchEntry(dataset, { fetch: serving(download) });
    expect(provenance.members).toEqual(["train.txt", "valid.txt", "test.txt"]);
    expect("edges" in data && data.edges[0]).toEqual({ source: "person100", target: "person80", type: "term6", split: "train" });
    expect("edges" in data && data.edges.at(-1)).toEqual({ source: "person20", target: "person90", type: "term11", split: "test" });
    expect((await roundTripEntry(dataset, { fetch: serving(download) })).holds).toBe(true);
  });

  it("reads a zip of quoted splits, passing over the dictionaries and resource forks beside them", async () => {
    const dataset = datasetFor({ status: "fetchable", source: 0, archive: { kind: "zip", parts: splitParts("wikikg2/") }, parser: { ...TRIPLES, quoted: true } }, "relations-split");
    const download = zip([
      { path: "wikikg2/entities.dict", text: '0\t"Q1"\n' },
      { path: "wikikg2/train.txt", text: WIKIKG2_TRAIN },
      { path: "__MACOSX/wikikg2/._train.txt", text: "resource fork" },
      { path: "wikikg2/valid.txt", text: WIKIKG2_TRAIN },
      { path: "wikikg2/test.txt", text: WIKIKG2_TRAIN },
    ]);
    const { data } = await fetchEntry(dataset, { fetch: serving(download) });
    expect("edges" in data && data.edges[0]).toEqual({ source: "Q8016027", target: "Q12177413", type: "P166", split: "train" });
    // Three triples of six distinct entities, the same in each split.
    expect("nodes" in data && data.nodes.map((node) => node.id)).toEqual(["Q8016027", "Q12177413", "Q6986100", "Q82955", "Q231256", "Q5"]);
  });

  it("reads one gzipped file with a header into edges with no split", async () => {
    const dataset = datasetFor({ status: "fetchable", source: 0, archive: { kind: "gzip" }, parser: { ...TRIPLES, header: "names" } }, "relations");
    const { data } = await fetchEntry(dataset, { fetch: serving(gzip(HETIONET)) });
    expect("edges" in data && data.edges[0]).toEqual({ source: "Gene::9021", target: "Biological Process::GO:0071357", type: "GpBP" });
    expect((await roundTripEntry(dataset, { fetch: serving(gzip(HETIONET)) })).holds).toBe(true);
  });

  it("fails the extract step when a split's member is missing", async () => {
    const dataset = datasetFor({ status: "fetchable", source: 0, archive: { kind: "tar.gz", parts: splitParts("") }, parser: TRIPLES }, "relations-split");
    await expect(fetchEntry(dataset, { fetch: serving(gzip(tar([{ path: "train.txt", text: KINSHIP_TRAIN }]))) })).rejects.toThrow(/extract.*member valid\.txt, found 0/s);
  });
});

describe("an HGB recipe", () => {
  it("reads node.dat and link.dat from the zip into typed nodes and typed edges, and the round trip holds", async () => {
    const dataset = datasetFor({ status: "fetchable", source: 0, archive: { kind: "zip", parts: HGB_PARTS }, parser: { format: "hgb", encoding: "utf-8", ...DBLP_TYPES } }, "typed");
    const { data, provenance } = await fetchEntry(dataset, { fetch: serving(dblpDownload) });
    expect(provenance.members).toEqual(["DBLP/node.dat", "DBLP/link.dat"]);
    expect("nodes" in data && data.nodes[1]).toEqual({ id: "4057", type: "paper" });
    expect("edges" in data && data.edges[0]).toEqual({ source: "262", target: "4057", type: "author-paper" });
    expect((await roundTripEntry(dataset, { fetch: serving(dblpDownload) })).holds).toBe(true);
  });

  it("is refused without both of its parts, and a parts archive is refused for a parser that reads one file", () => {
    const hgb = { format: "hgb", encoding: "utf-8", ...DBLP_TYPES };
    expect(() => parseEntry(entryFor({ status: "fetchable", source: 0, archive: { kind: "zip", member: { path: "DBLP/link.dat" } }, parser: hgb }, "typed"))).toThrow(CatalogueSyntaxError);
    expect(() => parseEntry(entryFor({ status: "fetchable", source: 0, archive: { kind: "zip", parts: [HGB_PARTS[0]] }, parser: hgb }, "typed"))).toThrow(/reads the parts nodes and links/);
    expect(() => parseEntry(entryFor({ status: "fetchable", source: 0, archive: { kind: "zip", parts: HGB_PARTS }, parser: { format: "gml", encoding: "utf-8" } }, "typed"))).toThrow(/reads one file/);
    expect(() => parseEntry(entryFor({ status: "fetchable", source: 0, archive: { kind: "zip", parts: [HGB_PARTS[0], HGB_PARTS[0]] }, parser: TRIPLES }, "typed"))).toThrow(/its own name/);
    expect(() => parseEntry(entryFor({ status: "fetchable", source: 0, archive: { kind: "zip", parts: HGB_PARTS }, parser: { ...hgb, linkTypes: [{ name: "author-paper", source: "author", target: "editor" }] } }, "typed"))).toThrow(/node types the recipe names/);
  });
});

describe("a counts recipe", () => {
  it("reads user_artists.dat from the release into users, artists and weighted listened edges", async () => {
    const dataset = datasetFor({ status: "fetchable", source: 0, archive: { kind: "zip", member: { path: "user_artists.dat" } }, parser: { format: "user-item-counts", encoding: "utf-8", delimiter: "tab", skipLines: 1, itemType: "artist" } }, "typed-weighted");
    const download = zip([
      { path: "readme.txt", text: "HetRec 2011" },
      { path: "user_artists.dat", text: LASTFM },
      { path: "user_friends.dat", text: "userID\tfriendID\r\n2\t275\r\n" },
    ]);
    const { data } = await fetchEntry(dataset, { fetch: serving(download) });
    expect("edges" in data && data.edges[0]).toEqual({ source: "u:2", target: "a:51", type: "listened", weight: 13883 });
    expect((await roundTripEntry(dataset, { fetch: serving(download) })).holds).toBe(true);
  });
});

describe("the triples, HGB and counts recipes in the bundled catalogue", () => {
  /** The crosswalk that carries exactly what each parser emits: relations, with splits when the recipe reads named parts; node and edge types; types and a weight. */
  const expected = (dataset: Dataset): string | undefined => {
    const { recipe } = dataset.entry;
    if (recipe.status !== "fetchable") {
      return undefined;
    }
    if (recipe.parser.format === "kg-triples") {
      return "parts" in recipe.archive ? "crosswalks/graph-v1/relations-split.json" : "crosswalks/graph-v1/relations.json";
    }
    if (recipe.parser.format === "hgb") {
      return "crosswalks/graph-v1/typed.json";
    }

    return recipe.parser.format === "user-item-counts" ? "crosswalks/graph-v1/typed-weighted.json" : undefined;
  };
  const withParser = listDatasets().filter((dataset) => expected(dataset) !== undefined);

  it("covers the knowledge graph, HGB and Last.fm entries", () => {
    const ids = withParser.map((dataset) => dataset.entry.id);
    for (const id of ["kg-kinship", "fb15k-237", "wn18rr", "ogbl-wikikg2", "wikidata5m", "kg-codex-s", "nell-995", "hetionet", "acm", "acm-hgb", "dblp-het", "freebase", "imdb", "lastfm-hgb"]) {
      expect(ids).toContain(id);
    }
  });

  it.each(withParser.map((dataset) => [dataset.entry.id, dataset] as const))("%s reads with a crosswalk that carries every field its parser emits", (_id, dataset) => {
    expect("file" in dataset.entry.crosswalk && dataset.entry.crosswalk.file).toBe(expected(dataset));
    expect(getDataset(dataset.entry.id).crosswalk).toEqual(dataset.crosswalk);
  });
});
