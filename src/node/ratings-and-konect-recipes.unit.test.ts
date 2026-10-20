import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCrosswalk, type Crosswalk } from "crossmap";
import { describe, expect, it } from "vitest";
import { getDataset, listDatasets } from "../bundled";
import { createCatalogue, type Dataset } from "../catalogue";
import { bzip2, tar, zip } from "../test-support/archives";
import { fixtureManifest } from "../test-support/entries";
import { AMAZON, COLLABORATION, LESMIS, ML_100K, ML_1M, ML_25M, RADOSLAW, UCSOCIAL, WIKISPEEDIA } from "../test-support/excerpts";
import { fetchEntry, roundTripEntry, type FetchPort } from "./fetch-dataset";

/** The crosswalk files the catalogue ships for these two parsers, read from where they are committed. */
const CROSSWALK_DIR = join(import.meta.dirname, "../../catalogue/crosswalks/graph-v1");
const CROSSWALK_FILES = ["topology", "weighted", "timestamped", "weighted-timestamped", "rated"] as const;
const crosswalkFiles: Record<string, Crosswalk> = Object.fromEntries(CROSSWALK_FILES.map((name) => [`crosswalks/graph-v1/${name}.json`, parseCrosswalk(JSON.parse(readFileSync(join(CROSSWALK_DIR, `${name}.json`), "utf8")))]));

/** The edges taken from the weighted excerpt, and the edges of the Radoslaw excerpt. */
const WEIGHTED_SAMPLE = 3;
const RADOSLAW_EDGES = 4;

const URL_OF_SOURCE = "https://example.org/data/network";

/** A graph entry with one live source, the given recipe and the crosswalk file that carries what the parser emits. */
function datasetFor(recipe: unknown, crosswalk: string, properties: Readonly<Record<string, boolean | number>> = {}): Dataset {
  const entry = { id: "network", name: "Network", tags: [], category: "graph/v1", sources: [{ url: URL_OF_SOURCE, retrieved: "2026-10-20", status: "live" }], licence: { kind: "unrecorded" }, citations: [], recipe, crosswalk: { file: `crosswalks/graph-v1/${crosswalk}.json` }, expectedCounts: {}, properties };

  return createCatalogue({ manifest: fixtureManifest, crosswalks: crosswalkFiles, entries: [entry] }).listDatasets()[0] ?? expect.unreachable("the catalogue lists its one entry");
}

const serving = (body: Uint8Array | string): FetchPort => async () => Promise.resolve(new Response(body));

const konectRecipe = (parser: { readonly weighted: boolean; readonly timestamped: boolean }): unknown => ({
  status: "fetchable",
  source: 0,
  archive: { kind: "tar.bz2", member: { pattern: "(?:[^/]+/)?out\\.[^/]+" } },
  parser: { format: "konect", encoding: "utf-8", ...parser },
});

/** A KONECT download as the site serves it: a bzip2-compressed tar of the network's directory, holding the edges, a meta file and a readme. */
const konectDownload = (name: string, edges: string): Uint8Array =>
  bzip2(
    tar([
      { path: `${name}/meta.${name}`, text: `name: ${name}\ncode: XX\n` },
      { path: `${name}/out.${name}`, text: edges },
      { path: `${name}/README.${name}`, text: `${name} network, part of the Koblenz Network Collection\n` },
    ]),
  );

const ratingsRecipe = (archive: unknown, parser: Readonly<Record<string, unknown>>): unknown => ({
  status: "fetchable",
  source: 0,
  archive,
  parser: { format: "user-item-ratings", encoding: "utf-8", maxRating: 5, ...parser },
});

describe("a KONECT tar.bz2 recipe", () => {
  it("reads a weighted network's weights onto the edges, from the one member that holds the edges", async () => {
    const dataset = datasetFor(konectRecipe({ weighted: true, timestamped: false }), "weighted", { directed: false });
    const { data, provenance } = await fetchEntry(dataset, { fetch: serving(konectDownload("moreno_lesmis", LESMIS)) });
    expect(provenance.member).toBe("moreno_lesmis/out.moreno_lesmis");
    expect("edges" in data && data.edges.slice(0, WEIGHTED_SAMPLE)).toEqual([
      { source: "1", target: "2", weight: 1 },
      { source: "2", target: "3", weight: 8 },
      { source: "2", target: "4", weight: 10 },
    ]);
    expect((await roundTripEntry(dataset, { fetch: serving(konectDownload("moreno_lesmis", LESMIS)) })).holds).toBe(true);
  });

  it("reads a directed network's times onto the edges", async () => {
    const dataset = datasetFor(konectRecipe({ weighted: false, timestamped: true }), "timestamped");
    const { data } = await fetchEntry(dataset, { fetch: serving(konectDownload("opsahl-ucsocial", UCSOCIAL)) });
    expect("edges" in data && data.edges[0]).toEqual({ source: "1", target: "2", timestamp: 1082008561 });
    const radoslaw = await fetchEntry(dataset, { fetch: serving(konectDownload("radoslaw_email", RADOSLAW)) });
    expect("edges" in radoslaw.data && radoslaw.data.edges).toHaveLength(RADOSLAW_EDGES);
    expect((await roundTripEntry(dataset, { fetch: serving(konectDownload("opsahl-ucsocial", UCSOCIAL)) })).holds).toBe(true);
  });

  it("reads a bipartite network as two node sets and a plain pair file as a topology", async () => {
    const bipartite = await fetchEntry(datasetFor(konectRecipe({ weighted: false, timestamped: false }), "topology"), { fetch: serving(konectDownload("opsahl-collaboration", COLLABORATION)) });
    expect("nodes" in bipartite.data && bipartite.data.nodes.map((node) => node.id)).toEqual(["l:1", "r:1", "r:2", "r:3", "r:4"]);
    const pairs = await fetchEntry(datasetFor(konectRecipe({ weighted: false, timestamped: false }), "topology"), { fetch: serving(konectDownload("wikispeedia", WIKISPEEDIA)) });
    expect("edges" in pairs.data && pairs.data.edges).toEqual([
      { source: "1", target: "2" },
      { source: "2", target: "3" },
      { source: "4", target: "5" },
      { source: "6", target: "7" },
    ]);
  });

  it("fails the parse step, naming the cause, when the download is cut short", async () => {
    const lines = 200_000;
    const whole = konectDownload("moreno_lesmis", `% sym posweighted\n${"1 2 1\n".repeat(lines)}`);
    const cut = whole.subarray(0, Math.floor(whole.length / 2));
    await expect(fetchEntry(datasetFor(konectRecipe({ weighted: true, timestamped: false }), "weighted"), { fetch: serving(cut) })).rejects.toThrow(/extract.*not valid bzip2 data/s);
  });
});

describe("a ratings recipe", () => {
  const rated = (archive: unknown, parser: Readonly<Record<string, unknown>>): Dataset => datasetFor(ratingsRecipe(archive, parser), "rated");

  it("reads an Amazon file onto typed nodes and rated edges, and the round trip holds", async () => {
    const dataset = rated({ kind: "none" }, { delimiter: "comma", skipLines: 0, itemType: "product" });
    const { data } = await fetchEntry(dataset, { fetch: serving(AMAZON) });
    expect("edges" in data && data.edges[0]).toEqual({ source: "u:A1YS9MDZP93857", target: "p:0006428320", type: "rating", weight: 0.6, timestamp: 1394496000 });
    expect("nodes" in data && data.nodes.slice(0, 2)).toEqual([
      { id: "u:A1YS9MDZP93857", type: "user" },
      { id: "p:0006428320", type: "product" },
    ]);
    expect((await roundTripEntry(dataset, { fetch: serving(AMAZON) })).holds).toBe(true);
  });

  it.each([
    ["ml-100k", "u.data", ML_100K, { delimiter: "tab", skipLines: 0 }],
    ["ml-1m", "ratings.dat", ML_1M, { delimiter: "double-colon", skipLines: 0 }],
    ["ml-25m", "ratings.csv", ML_25M, { delimiter: "comma", skipLines: 1 }],
  ] as const)("reads the %s release from its zip, beside the files the release also holds", async (release, member, ratings, layout) => {
    const dataset = rated({ kind: "zip", member: { path: member } }, { ...layout, itemType: "movie" });
    const download = zip([
      { path: `${release}/README`, text: "readme" },
      { path: `${release}/${member}`, text: ratings },
      { path: `${release}/movies.dat`, text: "1::Toy Story (1995)::Animation\n" },
    ]);
    const { data, provenance } = await fetchEntry(dataset, { fetch: serving(download) });
    expect(provenance.member).toBe(`${release}/${member}`);
    expect("edges" in data && data.edges.every((edge) => edge.type === "rating" && typeof edge["weight"] === "number" && typeof edge["timestamp"] === "number")).toBe(true);
    expect("nodes" in data && data.nodes.every((node) => node.type === "user" || node.type === "movie")).toBe(true);
    expect((await roundTripEntry(dataset, { fetch: serving(download) })).holds).toBe(true);
  });
});

describe("the recipes in the bundled catalogue", () => {
  /** The crosswalk file that carries what a parser emits and nothing it does not: the topology plus exactly the edge fields (and for ratings the types) the parser's options give each edge. */
  const expected = (dataset: Dataset): string | undefined => {
    const { recipe } = dataset.entry;
    if (recipe.status !== "fetchable") {
      return undefined;
    }
    const { parser } = recipe;
    if (parser.format === "user-item-ratings") {
      return "crosswalks/graph-v1/rated.json";
    }
    if (parser.format !== "konect") {
      return undefined;
    }
    if (parser.weighted) {
      return parser.timestamped ? "crosswalks/graph-v1/weighted-timestamped.json" : "crosswalks/graph-v1/weighted.json";
    }

    return parser.timestamped ? "crosswalks/graph-v1/timestamped.json" : "crosswalks/graph-v1/topology.json";
  };
  const withParser = listDatasets().filter((dataset) => expected(dataset) !== undefined);

  it("covers the ratings and KONECT entries the catalogue lists", () => {
    const ids = withParser.map((dataset) => dataset.entry.id);
    for (const id of ["amazon-beauty", "movielens-25m", "konect-wikispeedia", "lesmis"]) {
      expect(ids).toContain(id);
    }
  });

  it.each(withParser.map((dataset) => [dataset.entry.id, dataset] as const))("%s reads with a crosswalk that carries every field its parser emits", (_id, dataset) => {
    expect("file" in dataset.entry.crosswalk && dataset.entry.crosswalk.file).toBe(expected(dataset));
    expect(getDataset(dataset.entry.id).crosswalk).toEqual(dataset.crosswalk);
  });
});
