import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { convertCatalogue, namespaceOf, netzschleuderCsv, parseWayback, type Outcome } from "./convert";
import { GraphboxCatalogueSchema, SourceCatalogueSchema } from "./source";

/* A small committed slice of the pipeline catalogue, one dataset per classification path, and of the graphbox catalogue for the overlap section. */
const pipeline = SourceCatalogueSchema.parse(JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/pipeline-slice.json"), "utf8")));
const graphbox = GraphboxCatalogueSchema.parse(JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/graphbox-slice.json"), "utf8")));
const { entries, report } = convertCatalogue(pipeline, graphbox);

function outcome(id: string): Outcome {
  const found = report.outcomes.find((candidate) => candidate.id === id);
  if (found === undefined) {
    throw new Error(`no outcome for ${id}`);
  }

  return found;
}

function entry(id: string) {
  const found = entries.find((candidate) => candidate.id === id);
  if (found === undefined) {
    throw new Error(`no entry for ${id}`);
  }

  return found;
}

describe("the seed import's classification", () => {
  it("reports every dataset of the source exactly once, in id order", () => {
    const ids = Object.keys(pipeline.datasets).sort();
    expect(report.outcomes.map((candidate) => candidate.id)).toEqual(ids);
  });

  it("converts a download whose recipe the catalogue records in full, without flags", () => {
    expect(outcome("amazon0302")).toEqual({ id: "amazon0302", outcome: "converted", recipe: "fetchable", flags: [] });
    expect(entry("amazon0302").recipe).toMatchObject({ archive: { kind: "gzip" }, parser: { format: "edge-list", delimiter: "detect" } });
  });

  it("flags each parser override, derived member and pinned snapshot the import supplied", () => {
    expect(outcome("wiki-vote").flags).toContain("pipeline parser override: delimiter tab");
    expect(outcome("nell-995").flags).toContain("pipeline parser override: skip 1 header line");
    expect(entry("nell-995").recipe).toMatchObject({ parser: { skipLines: 1 } });
    expect(outcome("adjnoun")).toMatchObject({ outcome: "converted-with-flags", recipe: "fetchable" });
    expect(outcome("csphd").flags).toEqual(["archive member chosen by extension .net or .paj, which the source catalogue does not record", "the source is dead and the recipe fetches its pinned Wayback snapshot"]);
    expect(outcome("advogato").flags).toEqual(["archive member chosen by extension .edges, which the source catalogue does not record"]);
  });

  it("pins a Wayback download as a dead source with its snapshot, reading the member the catalogue names", () => {
    const cities = entry("cities");
    expect(cities.sources[0]).toEqual({
      url: "http://vlado.fmf.uni-lj.si/pub/networks/data/2mode/cities.zip",
      retrieved: cities.sources[0]?.retrieved,
      status: "dead",
      snapshot: { url: "https://web.archive.org/web/20230601/http://vlado.fmf.uni-lj.si/pub/networks/data/2mode/cities.zip", timestamp: "20230601" },
    });
    expect(cities.recipe).toMatchObject({ archive: { kind: "zip", member: { path: "da6+.net" } }, parser: { format: "pajek" } });
  });

  it("reads LINQS citations from the citing paper to the cited one", () => {
    expect(entry("cora").recipe).toMatchObject({ archive: { kind: "tar.gz", member: { extensions: [".cites"] } }, parser: { delimiter: "tab", sourceColumn: 1, targetColumn: 0 } });
  });

  it("applies the Netzschleuder rule to landing pages and graph-tool files alike", () => {
    expect(outcome("7th_graders").flags[0]).toMatch(/^Netzschleuder:/);
    expect(entry("7th_graders").sources.map((source) => source.url)).toContain("https://networks.skewed.de/net/7th_graders/files/7th_graders.csv.zip");
    expect(entry("bos_genetic").sources.map((source) => source.url)).toContain("https://networks.skewed.de/net/genetic_multiplex/files/Bos_Multiplex_Genetic.csv.zip");
    expect(entry("netzschleuder-bison").recipe).toMatchObject({ archive: { kind: "zip", member: { path: "edges.csv" } }, parser: { delimiter: "comma", commentPrefixes: ["#"] } });
  });

  it("drops auth-walled and local-file downloads, naming them, and keeps the rest", () => {
    expect(outcome("h-pokec").flags).toContain("dropped an auth-walled download at www.kaggle.com");
    expect(entry("h-pokec").sources.every((source) => !source.url.includes("kaggle"))).toBe(true);
    expect(outcome("oag-eng").flags).toContain("dropped a download that is a local file path, not a public source");
    expect(entry("oag-eng").sources.every((source) => source.url.startsWith("https://"))).toBe(true);
  });

  it("marks an entry not fetchable when no download has a declarative form, saying why", () => {
    expect(outcome("lesmis")).toMatchObject({ outcome: "converted-with-flags", recipe: "not-fetchable" });
    expect(entry("lesmis").recipe).toEqual({ status: "not-fetchable", reason: "no download is in a form keepset reads yet (konect-tarbz2: bzip2 compression has no keepset unpacker yet)" });
    expect(entry("ieee-cis-g").recipe).toMatchObject({ status: "not-fetchable" });
  });

  it("resolves a snapshot of a snapshot to the innermost capture and skips a directory listing", () => {
    const journals = entry("pajek-journals");
    expect(journals.sources[1]).toMatchObject({ url: "http://vlado.fmf.uni-lj.si/pub/networks/data/2mode/revije.zip", status: "dead", snapshot: { timestamp: "20130507053929" } });
    expect(journals.recipe).toMatchObject({ status: "fetchable", source: 1 });
  });

  it("does not guess the columns of a knowledge-graph triple file or the member of an archive in format various", () => {
    expect(entry("kg-nations").recipe).toMatchObject({ status: "not-fetchable" });
    expect(JSON.stringify(entry("kg-nations").recipe)).toMatch(/head and tail columns/);
    // arenas-pgp's first download is an archive in format various, so the recipe reads its second, a GML archive.
    expect(entry("arenas-pgp").recipe).toMatchObject({ status: "fetchable", source: 1, parser: { format: "gml" } });
  });

  it("skips a download that is a web page and reads the next one", () => {
    const arxiv = entry("arxiv-citations");
    expect(arxiv.sources.map((source) => source.url)).toEqual(["https://snap.stanford.edu/data/cit-HepPh.html", "https://snap.stanford.edu/data/cit-HepPh.txt.gz"]);
    expect(arxiv.recipe).toMatchObject({ status: "fetchable", source: 1, archive: { kind: "gzip" } });
  });

  it("does not convert datasets with nothing to fetch or no retrieval date, saying why", () => {
    expect(outcome("ba-weighted-200k")).toMatchObject({ outcome: "not-converted", reason: "synthetic: generated by the pipeline, with no source to fetch" });
    expect(outcome("bitcoin-blockchain")).toMatchObject({ outcome: "not-converted", reason: "the source catalogue records no sources" });
    expect(outcome("ss-hb-bcspwr09")).toMatchObject({ outcome: "not-converted", reason: "the source catalogue records no download URL" });
    expect(outcome("celegans-metabolic-undir")).toMatchObject({ outcome: "not-converted" });
    expect(JSON.stringify(outcome("celegans-metabolic-undir"))).toMatch(/no retrieval date/);
    for (const id of ["ba-weighted-200k", "bitcoin-blockchain", "ss-hb-bcspwr09", "celegans-metabolic-undir"]) {
      expect(entries.some((candidate) => candidate.id === id)).toBe(false);
    }
  });

  it("carries descriptive metadata as data and recorded counts as expected counts", () => {
    const seventh = entry("7th_graders");
    expect(seventh).toMatchObject({ name: "Seventh Graders Network", domain: "Social network", tags: ["heterogeneous"], category: "graph/v1", licence: { kind: "unrecorded" }, expectedCounts: { nodes: 29, edges: 740 } });
    expect(seventh.properties).toMatchObject({ directed: true, multigraph: true, selfLoops: false });
    expect(seventh.crosswalk).toEqual({ file: "crosswalks/graph-v1/topology.json" });
  });

  it("names the judgement-call removals, the omitted fields and the graphbox overlap without merging", () => {
    expect(report.judgementCallRemovals.map((removal) => removal.id)).toEqual(["yelp-hin", "foursquare", "douban"]);
    expect(report.omittedFields.map((omitted) => omitted.field)).toContain("citeKey");
    expect(report.graphboxOverlap).toEqual([
      { pipelineId: "adjnoun", graphboxId: "adjnoun", matchedBy: "id" },
      { pipelineId: "arxiv-citations", graphboxId: "cit-hepph", matchedBy: "download URL" },
    ]);
  });
});

describe("the URL helpers", () => {
  it("parses both Wayback forms and nothing else", () => {
    expect(parseWayback("https://web.archive.org/web/20061110114126id_/http://www.nd.edu/a.gz")).toEqual({ timestamp: "20061110114126", original: "http://www.nd.edu/a.gz" });
    expect(parseWayback("https://web.archive.org/web/20230601/http://example.org/x.zip")).toEqual({ timestamp: "20230601", original: "http://example.org/x.zip" });
    expect(parseWayback("https://example.org/web/20230601/http://example.org/x.zip")).toBeUndefined();
  });

  it("derives Netzschleuder's CSV archive", () => {
    expect(netzschleuderCsv("https://networks.skewed.de/net/copenhagen/files/bt.gt.zst")).toBe("https://networks.skewed.de/net/copenhagen/files/bt.csv.zip");
    expect(netzschleuderCsv("https://networks.skewed.de/net/moreno_sheep/")).toBe("https://networks.skewed.de/net/moreno_sheep/files/moreno_sheep.csv.zip");
  });
});

describe("namespaceOf", () => {
  it("files a SuiteSparse id under the collection and its group, with the rest of the id as its name", () => {
    expect(namespaceOf("ss-gset-g53")).toEqual({ namespace: ["suitesparse", "gset"], alias: "g53" });
    expect(namespaceOf("ss-dimacs10-channel-500x100x100-b050")).toEqual({ namespace: ["suitesparse", "dimacs10"], alias: "channel-500x100x100-b050" });
  });

  it("files an id with a collection prefix under that collection", () => {
    expect(namespaceOf("pajek-hep-th")).toEqual({ namespace: ["pajek"], alias: "hep-th" });
    expect(namespaceOf("nr-eco-everglades")).toEqual({ namespace: ["networkrepository"], alias: "eco-everglades" });
  });

  it("leaves an id whose prefix is part of an upstream dataset's name without a namespace", () => {
    expect(namespaceOf("ca-astroph")).toBeUndefined();
    expect(namespaceOf("p2p-gnutella09")).toBeUndefined();
    expect(namespaceOf("cora")).toBeUndefined();
  });

  it("names nothing for an id that is only a prefix or a prefix and a group", () => {
    expect(namespaceOf("pajek")).toBeUndefined();
    expect(namespaceOf("ss-gset")).toBeUndefined();
    expect(namespaceOf("ss")).toBeUndefined();
  });
});
