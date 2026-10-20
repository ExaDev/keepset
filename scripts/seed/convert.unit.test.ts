import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { convertCatalogue, convertDataset, NAME_OVERRIDES, namespaceOf, netzschleuderCsv, parseWayback, type Outcome } from "./convert";
import { GraphLicencesSchema, graphLicenceResolver } from "./licence";
import { GraphboxCatalogueSchema, SourceCatalogueSchema } from "./source";

/* A small committed slice of the pipeline catalogue, one dataset per classification path, and of the graphbox catalogue for the overlap section. */
const pipeline = SourceCatalogueSchema.parse(JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/pipeline-slice.json"), "utf8")));
const graphbox = GraphboxCatalogueSchema.parse(JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/graphbox-slice.json"), "utf8")));

const stated = (id: string, name: string, prefixes: readonly string[]) => ({ id, name, prefixes, terms: { licence: { kind: "spdx", id: "CC-BY-4.0" }, statedAt: `https://${id}.example/terms`, statement: `${name} states CC-BY-4.0` } });
const unstated = (id: string, name: string, prefixes: readonly string[]) => ({ id, name, prefixes, terms: { readAt: [`https://${id}.example/about`], reason: `${name} states no terms` } });
/* A licence curation covering exactly the hosts the slice's recipes read from: Pajek states one licence for everything it hosts, the others state none, and the Hugging Face dataset states its own. GroupLens is curated per dataset. */
const licences = GraphLicencesSchema.parse({
  readOn: "2026-10-20",
  publishers: [
    unstated("netzschleuder", "Netzschleuder", ["https://networks.skewed.de/"]),
    unstated("newman", "Newman", ["https://websites.umich.edu/"]),
    unstated("nrvis", "Network Repository", ["http://nrvis.com/", "http://networkrepository.com/"]),
    unstated("snap", "SNAP", ["https://snap.stanford.edu/"]),
    stated("pajek", "Pajek", ["http://vlado.fmf.uni-lj.si/"]),
    unstated("linqs", "LINQS", ["https://linqs-data.soe.ucsc.edu/"]),
    unstated("conve", "ConvE", ["https://github.com/TimDettmers/ConvE/"]),
    unstated("konect", "KONECT", ["http://konect.cc/"]),
    unstated("example", "Example", ["https://example.org/"]),
    unstated("amazon-ratings", "Amazon product data", ["http://jmcauley.ucsd.edu/"]),
    { id: "grouplens", name: "GroupLens", prefixes: ["https://files.grouplens.org/datasets/"], perDataset: true },
    unstated("openke", "OpenKE", ["https://raw.githubusercontent.com/thunlp/OpenKE/"]),
    { id: "huggingface", name: "Hugging Face", prefixes: ["https://huggingface.co/"], perDataset: true },
  ],
  datasets: {
    ...Object.fromEntries(["movielens-100k", "movielens-1m", "movielens-10m", "movielens-25m", "movielens-unread"].map((id) => [id, { readAt: ["https://files.grouplens.org/datasets/movielens/"], reason: "The release page states no terms." }])),
    "ieee-cis-g": { licence: { kind: "spdx", id: "MIT" }, statedAt: "https://huggingface.co/api/datasets/example/data", statement: "The card's licence field is mit." },
    "oag-eng": { readAt: ["https://huggingface.co/api/datasets/example/data"], reason: "The card has no licence field." },
  },
});
/* A resolver is single use: it remembers which curation records a conversion used. The slice holds none of the datasets NAME_OVERRIDES renames, so it converts with no overrides; the overrides are tested against the committed full catalogue below. */
const resolver = () => graphLicenceResolver(licences);
const { entries, report } = convertCatalogue(pipeline, graphbox, resolver(), new Map());

/** What the source catalogue records for the collaboration network's nodes, which the import corrects without editing it. */
const CATALOGUE_COLLABORATION_NODES = 22015;

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

  it("reads a UCINet download's first matrix with the DL parser, and gives a download that is not DL its reason", () => {
    expect(entry("ucinet-zachary").recipe).toEqual({ status: "fetchable", source: 0, archive: { kind: "none" }, parser: { format: "ucinet-dl", encoding: "utf-8", matrix: 1 } });
    expect(outcome("ucinet-zachary").flags).toContain("UCINet DL: the recipe reads the file's first matrix, the one the pipeline reads");
    expect(entry("ucinet-knokbur").recipe).toEqual({
      status: "not-fetchable",
      reason: "no download is in a form keepset reads yet (ucinet: the file is not a DL file: its first line says it has to be converted into DL format, and its matrices sit under comma-separated headers and end with DOS end-of-file marks)",
    });
  });

  it("reads a GD contest problem from the zip inside the contest bundle", () => {
    expect(entry("pajek-gd04-prob1").recipe).toMatchObject({ status: "fetchable", archive: { kind: "zip", member: { extensions: [".zip"] }, inner: { kind: "zip", member: { path: "challenge/prob1.gd4" } } }, parser: { format: "gd-contest", encoding: "utf-8" } });
    expect(outcome("pajek-gd04-prob1").flags).toContain("GD contest bundle: the problem is read from the bundle's one inner .zip member, which the source catalogue does not record");
  });

  it("marks an entry not fetchable when no download has a declarative form, saying why", () => {
    expect(entry("ieee-cis-g").recipe).toMatchObject({ status: "not-fetchable" });
  });

  it("reads a bzip2 download as a bare bzip2 file when its name says so", () => {
    expect(entry("bz2-edges").recipe).toMatchObject({ status: "fetchable", archive: { kind: "bzip2" }, parser: { format: "edge-list" } });
    expect(entry("bz2-edges").crosswalk).toEqual({ file: "crosswalks/graph-v1/topology.json" });
  });

  it("reads an Amazon ratings file as comma-separated ratings with no header, rated by the shared ratings crosswalk", () => {
    for (const id of ["amazon-musical-instruments", "amazon-movies-tv"]) {
      expect(entry(id).recipe).toMatchObject({ status: "fetchable", archive: { kind: "none" }, parser: { format: "user-item-ratings", delimiter: "comma", skipLines: 0, itemType: "product", maxRating: 5 } });
      expect(entry(id).crosswalk).toEqual({ file: "crosswalks/graph-v1/rated.json" });
      expect(outcome(id).flags).toContain("ratings layout read from the downloaded file: user, product, rating and time separated by commas, with no header");
    }
  });

  it("reads each MovieLens release in the layout that release has, naming the member", () => {
    expect(entry("movielens-100k").recipe).toMatchObject({ archive: { kind: "zip", member: { path: "u.data" } }, parser: { format: "user-item-ratings", delimiter: "tab", skipLines: 0, itemType: "movie", maxRating: 5 } });
    expect(entry("movielens-1m").recipe).toMatchObject({ archive: { kind: "zip", member: { path: "ratings.dat" } }, parser: { delimiter: "double-colon", skipLines: 0 } });
    expect(entry("movielens-10m").recipe).toMatchObject({ archive: { kind: "zip", member: { path: "ratings.dat" } }, parser: { delimiter: "double-colon", skipLines: 0 } });
    expect(entry("movielens-10m").crosswalk).toEqual({ file: "crosswalks/graph-v1/rated.json" });
    expect(outcome("movielens-10m").flags).toContain("ratings layout of ml-10m read from the release: ratings.dat, delimiter double-colon, 0 header lines");
  });

  it("gives a release whose whole fetch failed no recipe, though its layout is read", () => {
    expect(entry("movielens-25m").recipe).toEqual({
      status: "not-fetchable",
      reason: "no download is in a form keepset reads yet (movielens: the ratings file has more edges than one fetch can hold: the crosswalk step aborts on it with an allocation failure (ExaDev/crossmap#57), where ml-10m completes)",
    });
  });

  it("does not guess the layout of a MovieLens release it has not read", () => {
    expect(entry("movielens-unread").recipe).toEqual({ status: "not-fetchable", reason: "no download is in a form keepset reads yet (movielens: a MovieLens release whose ratings layout the import has not read)" });
  });

  it("reads each KONECT archive with the columns its file has, choosing the crosswalk that carries them", () => {
    const member = { pattern: "(?:[^/]+/)?out\\.[^/]+" };
    expect(entry("lesmis").recipe).toMatchObject({ status: "fetchable", archive: { kind: "tar.bz2", member }, parser: { format: "konect", weighted: true, timestamped: false } });
    expect(entry("lesmis").crosswalk).toEqual({ file: "crosswalks/graph-v1/weighted.json" });
    expect(entry("konect-opsahl-ucsocial").recipe).toMatchObject({ parser: { format: "konect", weighted: false, timestamped: true } });
    expect(entry("konect-opsahl-ucsocial").crosswalk).toEqual({ file: "crosswalks/graph-v1/timestamped.json" });
    // The catalogue calls this download `tsv`, and the bipartite and plain pair files read with the topology crosswalk.
    expect(entry("konect-wikispeedia").recipe).toMatchObject({ archive: { kind: "tar.bz2" }, parser: { format: "konect", weighted: false, timestamped: false } });
    expect(entry("konect-opsahl-collaboration").crosswalk).toEqual({ file: "crosswalks/graph-v1/topology.json" });
    expect(outcome("lesmis").flags).toContain("KONECT edge columns read from the downloaded file: the catalogue records only the download");
  });

  it("corrects what a downloaded file contradicts in the catalogue's record, saying so in the report", () => {
    const collaboration = entry("konect-opsahl-collaboration");
    expect(collaboration.expectedCounts).toEqual({ nodes: 38741, edges: 58595 });
    expect(collaboration.properties).toMatchObject({ weighted: false, multigraph: false, selfLoops: false, connected: false, components: 1188, directed: false });
    expect(collaboration.description).toMatch(/^Bipartite authorship network/);
    expect(outcome("konect-opsahl-collaboration").flags.some((flag) => flag.startsWith("corrected against the downloaded file: the file is a bipartite authorship network"))).toBe(true);
    expect(entry("movielens-25m").description).toContain("59,047 movies");
    expect(entry("amazon-movies-tv").description).toMatch(/^Undirected bipartite/);
    // The source catalogue is read, never written, and an entry with no correction keeps its record.
    expect(pipeline.datasets["konect-opsahl-collaboration"]?.nodeCount).toBe(CATALOGUE_COLLABORATION_NODES);
    expect(entry("konect-opsahl-ucsocial").expectedCounts).toEqual({ nodes: 1899, edges: 59835 });
    expect(outcome("konect-opsahl-ucsocial").flags.some((flag) => flag.startsWith("corrected"))).toBe(false);
  });

  it("does not guess the columns of a KONECT archive it has not read", () => {
    expect(entry("konect-unread").recipe).toEqual({ status: "not-fetchable", reason: "no download is in a form keepset reads yet (tsv: a KONECT archive whose edge columns the import has not read)" });
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
    expect(arxiv.sources.map((source) => source.url)).toEqual(["https://snap.stanford.edu/data/cit-HepPh.html", "https://snap.stanford.edu/data/cit-HepPh.txt.gz", "https://snap.stanford.edu/data/index.html"]);
    expect(arxiv.recipe).toMatchObject({ status: "fetchable", source: 1, archive: { kind: "gzip" } });
  });

  it("reads a landing page recorded as a homepage like a bare landing-page URL, and the endpoint columns and header lines a download records", () => {
    const arxiv = entry("arxiv-citations");
    expect(arxiv.recipe).toMatchObject({ status: "fetchable", source: 1 });
    expect(arxiv.sources.map((source) => source.url)).toContain("https://snap.stanford.edu/data/index.html");
    expect(outcome("triple-table").flags).toEqual(expect.arrayContaining(["catalogue: skip 1 header line", "catalogue: edge endpoints in columns 0 and 2"]));
    expect(entry("triple-table").recipe).toMatchObject({ status: "fetchable", parser: { format: "edge-list", skipLines: 1, sourceColumn: 0, targetColumn: 2 } });
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

  it("takes each entry's licence from the curation of the source its recipe fetches, a dataset record winning over its publisher", () => {
    expect(entry("cities").licence).toEqual({ kind: "spdx", id: "CC-BY-4.0" });
    expect(entry("ieee-cis-g").licence).toEqual({ kind: "spdx", id: "MIT" });
    expect(entry("oag-eng").licence).toEqual({ kind: "unrecorded" });
    // The recipe reads the Network Repository copy, so that publisher's curation decides, not the Wayback-pinned Arenas page the first source points at.
    expect(entry("arenas-pgp").sources.map((source) => source.url)).toContain("http://networkrepository.com/datasets/pgp.tar.gz");
    expect(entry("arenas-pgp").licence).toEqual({ kind: "unrecorded" });
  });

  it("refuses a dataset no licence curation covers, and curation that serves no dataset", () => {
    const only = (publishers: readonly unknown[], datasets: Record<string, unknown> = {}) => graphLicenceResolver(GraphLicencesSchema.parse({ readOn: "2026-10-20", publishers, datasets }));
    expect(() => convertCatalogue(pipeline, graphbox, only([]), new Map())).toThrow(/no licence curation covers/);
    const everything = licences.publishers.map((publisher) => ({ ...publisher }));
    expect(() => convertCatalogue(pipeline, graphbox, only([...everything, unstated("unused", "Unused", ["https://unused.example/"])], licences.datasets), new Map())).toThrow(/no dataset's source falls under: unused/);
    expect(() => convertCatalogue(pipeline, graphbox, only(everything, { ...licences.datasets, "not-a-dataset": { readAt: ["https://example.org/"], reason: "x" } }), new Map())).toThrow(/not-a-dataset/);
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

describe("name overrides", () => {
  it("replaces the name of a listed dataset and leaves every other name as the catalogue gives it", () => {
    const renamed = convertCatalogue(pipeline, graphbox, resolver(), new Map([["wiki-vote", "Wikipedia votes (a source)"]])).entries;
    expect(renamed.find((candidate) => candidate.id === "wiki-vote")?.name).toBe("Wikipedia votes (a source)");
    expect(renamed.find((candidate) => candidate.id === "amazon0302")?.name).toBe(entry("amazon0302").name);
  });

  it("refuses an override for a dataset the catalogue lacks, or one that repeats the catalogue's name", () => {
    expect(() => convertCatalogue(pipeline, graphbox, resolver(), new Map([["absent", "Anything"]]))).toThrow("the name override for absent names no dataset of the catalogue");
    expect(() => convertCatalogue(pipeline, graphbox, resolver(), new Map([["wiki-vote", entry("wiki-vote").name]]))).toThrow("the name override for wiki-vote repeats the name the catalogue already gives it");
  });

  it("renames, in the committed full catalogue, every dataset it lists to the name it gives", () => {
    const full = SourceCatalogueSchema.parse(JSON.parse(readFileSync(join(import.meta.dirname, "sources/pipeline-catalog.json"), "utf8")));
    const fullLicences = graphLicenceResolver(GraphLicencesSchema.parse(JSON.parse(readFileSync(join(import.meta.dirname, "sources/graph-licences.json"), "utf8"))));
    for (const [id, name] of NAME_OVERRIDES) {
      const dataset = Object.values(full.datasets).find((candidate) => candidate.id === id);
      expect(dataset, id).toBeDefined();
      expect(dataset === undefined ? undefined : convertDataset(dataset, fullLicences).entry?.name, id).toBe(name);
    }
  });

  it("gives each override a name that no other override shares, ignoring case", () => {
    const names = [...NAME_OVERRIDES.values()].map((name) => name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
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
