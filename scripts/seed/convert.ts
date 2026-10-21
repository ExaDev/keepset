import { parseEntry, waybackUrl, type Archive, type Citation, type Entry, type Parser, type Recipe, type Source } from "../../src/entry";
import type { InstanceFormat } from "../../src/parsers/instance-shapes";
import type { JsonScalar } from "../../src/targets/json-scalar";
import type { GraphLicenceResolver } from "./licence";
import type { GraphboxCatalogue, SourceCatalogue, SourceDataset, SourceDownload, SourceEntry, StructuredCitation } from "./source";

/** The crosswalk files of graph/v1, each for the fields of the native graph a parser emits: the topology every parser emits, and with it the edge weight, the edge time, both, or (for the ratings parser) node and edge types as well. */
export const CROSSWALKS = {
  topology: "crosswalks/graph-v1/topology.json",
  weighted: "crosswalks/graph-v1/weighted.json",
  timestamped: "crosswalks/graph-v1/timestamped.json",
  weightedTimestamped: "crosswalks/graph-v1/weighted-timestamped.json",
  rated: "crosswalks/graph-v1/rated.json",
} as const;
export type CrosswalkFile = (typeof CROSSWALKS)[keyof typeof CROSSWALKS];

/**
 * Per-dataset parser options the thesis pipeline sets in Python rather than in its catalogue (`BENCHMARK_DATASETS` and `HETEROGENEOUS_DATASETS` in experiments/shared/infrastructure/benchmark_data.py of Mearman/Thesis). The import carries them into the recipe as stated options and flags each one in the report.
 */
export const PIPELINE_PARSER_OVERRIDES: ReadonlyMap<string, { readonly delimiter?: "space" | "tab"; readonly skipLines?: number }> = new Map([
  ["karate", { delimiter: "space" }],
  ["lesmis", { delimiter: "space" }],
  ["wiki-vote", { delimiter: "tab" }],
  ["facebook", { delimiter: "space" }],
  ["dblp", { delimiter: "tab" }],
  ["ca-astroph", { delimiter: "tab" }],
  ["ca-condmat", { delimiter: "tab" }],
  ["ca-hepph", { delimiter: "tab" }],
  ["cit-hepph", { delimiter: "tab" }],
  ["cit-hepth", { delimiter: "tab" }],
  ["cit-patents", { delimiter: "tab" }],
  ["com-youtube", { delimiter: "tab" }],
  ["com-lj", { delimiter: "tab" }],
  ["wiki-topcats", { delimiter: "tab" }],
  ["as-skitter", { delimiter: "tab" }],
  ["nell-995", { skipLines: 1 }],
]);

/** Downloads, by original URL, whose bytes are not in the format the catalogue records, found by reading them: the import gives each the reason in place of a recipe that would fail. */
export const MISRECORDED_DOWNLOADS: ReadonlyMap<string, string> = new Map([["http://vlado.fmf.uni-lj.si/pub/networks/data/UciNet/knokbur.dat", "the file is not a DL file: its first line says it has to be converted into DL format, and its matrices sit under comma-separated headers and end with DOS end-of-file marks"]]);

/** Datasets the pipeline removed by judgement rather than recording in its catalogue (the comment beside `HETEROGENEOUS_DATASETS` in the same file): named in the report so their absence is visible. */
export const JUDGEMENT_CALL_REMOVALS: readonly { readonly id: string; readonly reason: string }[] = [
  { id: "yelp-hin", reason: "removed by the pipeline: no automatable download source" },
  { id: "foursquare", reason: "removed by the pipeline: no automatable download source" },
  { id: "douban", reason: "removed by the pipeline: no automatable download source" },
];

/** Catalogue fields the import deliberately does not carry: thesis-specific experiment parameters, not properties of the dataset. */
export const OMITTED_FIELDS: readonly { readonly field: string; readonly reason: string }[] = [
  { field: "citeKey", reason: "the thesis bibliography key for the dataset, meaningful only inside the thesis" },
  { field: "maxPaths", reason: "a path-enumeration budget for the thesis experiments, not a property of the dataset" },
  { field: "preferredFormat", reason: "used only to choose which download the recipe reads" },
  { field: "properties sync-back", reason: "the pipeline writes detected structural properties back into its catalogue; keepset entries are not rewritten by fetching, and a fetch reports count drift as a warning instead" },
];

/** What a downloaded file shows the catalogue's record of a dataset to get wrong, found by reading the whole file when a recipe was written for it: the replacement description, expected node count and structural properties, with the reason. A correction is applied over the catalogue's record and flagged in the report; the source catalogue itself is never edited. */
export interface Correction {
  readonly description?: string;
  readonly expectedNodes?: number;
  readonly properties?: Readonly<Record<string, JsonScalar>>;
  readonly reason: string;
}

/** The movies a MovieLens ratings file rates are fewer than the movies its release lists, and the users who rate are fewer than the release's total in the older ones; a description counting them from the release page misstates the graph the file gives. */
const MOVIELENS_COUNT_REASON = "the description counts users and movies from the release's own statement, while the ratings file the recipe reads rates fewer movies (or has fewer users), and the graph has the nodes of the ratings file";

export const CORRECTIONS: ReadonlyMap<string, Correction> = new Map([
  [
    "konect-opsahl-collaboration",
    {
      description: "Bipartite authorship network of the arXiv condensed matter section (cond-mat) from 1995 to 1999: an edge joins an author, a left node, and a paper they wrote, a right node. The network is unweighted and has no repeated pairs.",
      expectedNodes: 38741,
      properties: { components: 1188, connected: false, cyclic: true, density: 7.808365090394136e-5, multigraph: false, selfLoops: false, weighted: false },
      reason:
        "the file is a bipartite authorship network (KONECT `% bip unweighted`) whose two node sets are numbered independently from 1, so its nodes are those of both sets, and it has no weights, no repeated pairs and no self loops; the catalogue's description, node count and structural properties describe a weighted co-authorship network with one node set",
    },
  ],
  [
    "movielens-1m",
    { description: "Bipartite user-movie rating network from the GroupLens research group. 1,000,209 ratings from 6,040 users on 3,706 movies. Edge weights are ratings normalised to [0, 1].", reason: MOVIELENS_COUNT_REASON },
  ],
  [
    "movielens-10m",
    { description: "Bipartite user-movie rating network from the GroupLens research group. 10,000,054 ratings from 69,878 users on 10,677 movies. Edge weights are ratings normalised to [0, 1].", reason: MOVIELENS_COUNT_REASON },
  ],
  [
    "movielens-25m",
    { description: "Bipartite user-movie rating network from the GroupLens research group. 25,000,095 ratings from 162,541 users on 59,047 movies. Edge weights are ratings normalised to [0, 1].", reason: MOVIELENS_COUNT_REASON },
  ],
  [
    "amazon-movies-tv",
    {
      description: "Undirected bipartite user-product review network for Movies and TV on Amazon. Users are linked to products they reviewed; edge weights are normalised star ratings.",
      reason: "the catalogue records this download as undirected (format amazon-ratings-undirected, property directed false), while its description calls the network directed",
    },
  ],
]);

/** The id prefixes that name a collection, each with the namespace its datasets are filed under. The pipeline catalogue mints ids, and only these prefixes mean "from this collection": others (`ca-`, `p2p-`, `amazon-`) are part of an upstream dataset's own name, and are left without a namespace. SuiteSparse ids are `ss-<group>-<name>` and are handled by `namespaceOf`, since the group is a second namespace segment. */
const COLLECTION_NAMESPACES: ReadonlyMap<string, string> = new Map([
  ["arenas", "arenas"],
  ["konect", "konect"],
  ["netzschleuder", "netzschleuder"],
  ["nr", "networkrepository"],
  ["pajek", "pajek"],
  ["snap", "snap"],
  ["ucinet", "ucinet"],
  ["wormwiring", "wormwiring"],
]);

/** The id prefix of the SuiteSparse Matrix Collection, whose ids carry the collection's group as their second part. */
const SUITESPARSE_PREFIX = "ss";

/**
 * Where an id sits in a collection, when its prefix says so: the namespace the entry is filed under and the name it has inside it, so a dataset the catalogue calls `ss-gset-g53` is `g53` in `suitesparse/gset`.
 * @param id - A pipeline catalogue dataset id.
 * @returns The namespace and the name within it, or undefined when the id names no collection or has no name left after its prefix.
 */
export function namespaceOf(id: string): { readonly namespace: readonly string[]; readonly alias: string } | undefined {
  const [prefix = "", ...parts] = id.split("-");
  if (prefix === SUITESPARSE_PREFIX) {
    const [group, ...rest] = parts;

    return group === undefined || rest.length === 0 ? undefined : { namespace: ["suitesparse", group], alias: rest.join("-") };
  }
  const collection = COLLECTION_NAMESPACES.get(prefix);

  return collection === undefined || parts.length === 0 ? undefined : { namespace: [collection], alias: parts.join("-") };
}

/** Hosts whose downloads need an account: the import drops them, and a dataset left with none is not converted. */
const AUTH_WALLED_HOSTS = new Set(["www.kaggle.com", "kaggle.com"]);

/** How one dataset converted. */
export type Outcome =
  | { readonly id: string; readonly outcome: "converted"; readonly recipe: Recipe["status"]; readonly flags: readonly string[] }
  | { readonly id: string; readonly outcome: "converted-with-flags"; readonly recipe: Recipe["status"]; readonly flags: readonly string[] }
  | { readonly id: string; readonly outcome: "not-converted"; readonly reason: string; readonly flags: readonly string[] };

/** A recipe chosen for one download, with the flags that say what the import had to supply beyond the catalogue's own record. */
interface Chosen {
  readonly url: string;
  readonly archive: Archive;
  readonly parser: Parser;
  readonly crosswalk: CrosswalkFile;
  readonly flags: readonly string[];
}

/** One public download, in catalogue order. */
interface Download {
  readonly url: string;
  readonly format: string | undefined;
  readonly innerPath: string | undefined;
}

const WAYBACK = /^https?:\/\/web\.archive\.org\/web\/(\d{8}(?:\d{6})?)(?:id_)?\/(https?:\/\/.+)$/;

/**
 * Splits a Wayback Machine URL into the original URL and the snapshot timestamp, accepting both the page form and the raw `id_` form. A snapshot of a snapshot (the catalogue holds a few) resolves to the innermost one, whose timestamp is when the file itself was captured.
 * @param url - A URL.
 * @returns The original URL and timestamp, or undefined for a URL that is not a snapshot.
 */
export function parseWayback(url: string): { readonly original: string; readonly timestamp: string } | undefined {
  let found: { original: string; timestamp: string } | undefined;
  for (let match = WAYBACK.exec(url); match?.[1] !== undefined && match[2] !== undefined; match = WAYBACK.exec(match[2])) {
    found = { timestamp: match[1], original: match[2] };
  }

  return found;
}

/**
 * The lower-cased path of a URL, without query or fragment: what its file extension is read from.
 * @param url - A URL.
 * @returns The path.
 */
function pathOf(url: string): string {
  return new URL(url).pathname.toLowerCase();
}

/**
 * The archive layout a URL's extension names, before any member is chosen.
 * @param url - The download URL (the original URL for a snapshot).
 * @returns The archive kind, or the reason no keepset unpacker reads it.
 */
function archiveKindOf(url: string): Exclude<Archive["kind"], "xlsx"> | { readonly unsupported: string } {
  const path = pathOf(url);
  for (const [extension, name] of [
    [".zst", "zstd"],
    [".7z", "7z"],
    [".xz", "xz"],
  ] as const) {
    if (path.endsWith(extension)) {
      return { unsupported: `${name} compression has no keepset unpacker yet` };
    }
  }
  if (path.endsWith(".tar.gz") || path.endsWith(".tgz")) {
    return "tar.gz";
  }
  if (path.endsWith(".tar.bz2") || path.endsWith(".tbz2") || path.endsWith(".tbz")) {
    return "tar.bz2";
  }
  if (path.endsWith(".bz2")) {
    return "bzip2";
  }
  if (path.endsWith(".tar")) {
    return "tar";
  }
  if (path.endsWith(".zip")) {
    return "zip";
  }
  if (path.endsWith(".gz")) {
    return "gzip";
  }
  if (path.endsWith(".html") || path.endsWith(".htm") || path.endsWith(".aspx")) {
    return { unsupported: "the download is a web page, not a data file" };
  }
  if (path.endsWith("/")) {
    return { unsupported: "the download is a directory listing, not a data file" };
  }

  return "none";
}

/** The parser formats the graph import maps a catalogue format to by name alone: those that read a graph and need no option beyond the encoding. The ratings and KONECT parsers have options, which the import reads from the file. */
type GraphFormat = Exclude<Parser["format"], "csv-table" | "geojson" | "user-item-ratings" | "konect" | InstanceFormat>;

/** The keepset parser each catalogue format reads with, by the pipeline's own dispatch (the format branches of experiments/pipeline/scripts/download_benchmark_graph.py in Mearman/Thesis): formats whose pipeline parser is the generic edge list, GML, Pajek, Matrix Market, UCINet DL or GD contest reader. */
const PARSERS: ReadonlyMap<string, GraphFormat | "linqs"> = new Map([
  ["matrix-market", "matrix-market"],
  ["gml", "gml"],
  ["pajek", "pajek"],
  ["net", "pajek"],
  ["paj", "pajek"],
  ["edge-list", "edge-list"],
  ["edgelist", "edge-list"],
  ["edges", "edge-list"],
  ["snap", "edge-list"],
  ["gz", "edge-list"],
  ["linqs", "linqs"],
  ["ucinet", "ucinet-dl"],
  ["ucinet-dl", "ucinet-dl"],
  ["dl", "ucinet-dl"],
  ["gd-contest", "gd-contest"],
]);

/** The file extensions each parser's member carries, for an archive whose member the catalogue does not name. */
const MEMBER_EXTENSIONS: Readonly<Record<GraphFormat | "linqs", readonly string[]>> = {
  "matrix-market": [".mtx"],
  gml: [".gml"],
  pajek: [".net", ".paj"],
  "edge-list": [".txt"],
  linqs: [".cites"],
  "ucinet-dl": [".dat", ".dl"],
  "gd-contest": [".gd4"],
};

/** Inner-path extensions the pipeline resolves a `various` download by (`get_parser_format`); anything else is its default edge list. */
const VARIOUS_BY_EXTENSION: ReadonlyMap<string, GraphFormat> = new Map([
  [".net", "pajek"],
  [".paj", "pajek"],
  [".gml", "gml"],
  [".mtx", "matrix-market"],
]);

/**
 * An edge-list parser with every option stated. The delimiter is detected from the data unless the pipeline fixes one, which is the pipeline's own rule (`parse_edge_list` with no delimiter): the catalogue does not record which delimiter a file uses.
 * @param options - The options that differ from a two-column list with a detected delimiter and `#` and `%` comments.
 * @returns The parser.
 */
function edgeList(options: Partial<Extract<Parser, { format: "edge-list" }>> = {}): Parser {
  return { format: "edge-list", encoding: "utf-8", delimiter: "detect", skipLines: 0, commentPrefixes: ["#", "%"], sourceColumn: 0, targetColumn: 1, ...options };
}

/** The layout of each MovieLens release's ratings file, read from the release (the layouts differ between releases), keyed by the release's archive name: the delimiter, the header lines before the first rating, and the member that holds the ratings. A rating is out of 5 in every release (the later ones add half stars). `notFetchable` is the reason a release whose whole fetch failed is given no recipe, though the parser reads its layout. */
const MOVIELENS_RELEASES: ReadonlyMap<string, { readonly delimiter: "comma" | "tab" | "double-colon"; readonly skipLines: number; readonly member: string; readonly notFetchable?: string }> = new Map([
  ["ml-100k", { delimiter: "tab", skipLines: 0, member: "u.data" }],
  ["ml-1m", { delimiter: "double-colon", skipLines: 0, member: "ratings.dat" }],
  ["ml-10m", { delimiter: "double-colon", skipLines: 0, member: "ratings.dat" }],
  ["ml-25m", { delimiter: "comma", skipLines: 1, member: "ratings.csv", notFetchable: "the ratings file has more edges than one fetch can hold: the crosswalk step aborts on it with an allocation failure (ExaDev/crossmap#57), where ml-10m completes" }],
]);

/** The top of the rating scale of the ratings the catalogue lists: five stars in an Amazon file and in every MovieLens release. */
const MAX_RATING = 5;

/** What a KONECT `out.*` file holds beyond the two node columns, read from the file because the catalogue records only the download: whether its third column is an edge weight and whether it has a time column. Keyed by the catalogue's dataset id. */
const KONECT_LAYOUTS: ReadonlyMap<string, { readonly weighted: boolean; readonly timestamped: boolean }> = new Map([
  ["konect-opsahl-collaboration", { weighted: false, timestamped: false }],
  ["konect-opsahl-ucsocial", { weighted: false, timestamped: true }],
  ["konect-radoslaw-email", { weighted: false, timestamped: true }],
  ["konect-wikispeedia", { weighted: false, timestamped: false }],
  ["lesmis", { weighted: true, timestamped: false }],
]);

/** The member of a KONECT archive that holds the edges: `out.<network>`, in the directory the archive unpacks to. */
const KONECT_EDGE_FILE = "(?:[^/]+/)?out\\.[^/]+";

/**
 * The recipe for a KONECT download, which is a bzip2-compressed tar archive of `out.<network>` (the edges), `meta.<network>` and a readme.
 * @param download - The download.
 * @param datasetId - The dataset.
 * @returns The recipe, or the reason there is none.
 */
function konectRecipe(download: Download, datasetId: string): Chosen | { readonly unsupported: string } {
  const layout = KONECT_LAYOUTS.get(datasetId);
  if (layout === undefined) {
    return { unsupported: "a KONECT archive whose edge columns the import has not read" };
  }
  const crosswalk = layout.weighted ? (layout.timestamped ? CROSSWALKS.weightedTimestamped : CROSSWALKS.weighted) : layout.timestamped ? CROSSWALKS.timestamped : CROSSWALKS.topology;

  return {
    url: download.url,
    archive: { kind: "tar.bz2", member: { pattern: KONECT_EDGE_FILE } },
    parser: { format: "konect", encoding: "utf-8", weighted: layout.weighted, timestamped: layout.timestamped },
    crosswalk,
    flags: ["KONECT edge columns read from the downloaded file: the catalogue records only the download"],
  };
}

/**
 * The recipe for a ratings download: an Amazon ratings file, or a MovieLens release's archive.
 * @param download - The download.
 * @param format - The catalogue's format.
 * @returns The recipe, or the reason there is none.
 */
function ratingsRecipe(download: Download, format: "amazon-ratings" | "amazon-ratings-undirected" | "movielens"): Chosen | { readonly unsupported: string } {
  const original = parseWayback(download.url)?.original ?? download.url;
  if (format !== "movielens") {
    return {
      url: download.url,
      archive: { kind: "none" },
      parser: { format: "user-item-ratings", encoding: "utf-8", delimiter: "comma", skipLines: 0, itemType: "product", maxRating: MAX_RATING },
      crosswalk: CROSSWALKS.rated,
      flags: ["ratings layout read from the downloaded file: user, product, rating and time separated by commas, with no header"],
    };
  }
  const release = /\/([^/]+)\.zip$/.exec(pathOf(original))?.[1];
  const layout = release === undefined ? undefined : MOVIELENS_RELEASES.get(release);
  if (release === undefined || layout === undefined) {
    return { unsupported: "a MovieLens release whose ratings layout the import has not read" };
  }

  if (layout.notFetchable !== undefined) {
    return { unsupported: layout.notFetchable };
  }

  return {
    url: download.url,
    archive: { kind: "zip", member: { path: layout.member } },
    parser: { format: "user-item-ratings", encoding: "utf-8", delimiter: layout.delimiter, skipLines: layout.skipLines, itemType: "movie", maxRating: MAX_RATING },
    crosswalk: CROSSWALKS.rated,
    flags: [`ratings layout of ${release} read from the release: ${layout.member}, delimiter ${layout.delimiter}, ${String(layout.skipLines)} header lines`],
  };
}

/**
 * Chooses a recipe for one download.
 * @param download - The download.
 * @param datasetId - The dataset, for the pipeline's parser overrides.
 * @returns The recipe parts and their flags, or the reason this download has no declarative recipe.
 */
function recipeFor(download: Download, datasetId: string): Chosen | { readonly unsupported: string } {
  const original = parseWayback(download.url)?.original ?? download.url;
  const kind = archiveKindOf(original);
  if (typeof kind === "object") {
    return kind;
  }
  const { format } = download;
  const misrecorded = MISRECORDED_DOWNLOADS.get(original);
  if (misrecorded !== undefined) {
    return { unsupported: misrecorded };
  }
  if (format === undefined) {
    return { unsupported: "the download records no format" };
  }
  if (format === "landing-page") {
    return { unsupported: "a landing page, not a download" };
  }
  if (format === "amazon-ratings" || format === "amazon-ratings-undirected" || format === "movielens") {
    return ratingsRecipe(download, format);
  }
  // The catalogue calls a KONECT archive `konect-tarbz2`, or `tsv` for the tab-separated files inside it.
  if ((format === "konect-tarbz2" || format === "tsv") && new URL(original).hostname === "konect.cc" && kind === "tar.bz2") {
    return konectRecipe(download, datasetId);
  }
  // Knowledge-graph triple files: which columns hold the head and the tail varies by benchmark and is not recorded, so only one the pipeline itself fixes (an entry in PIPELINE_PARSER_OVERRIDES) reads as an edge list.
  if ((format === "tsv" || format === "txt") && !PIPELINE_PARSER_OVERRIDES.has(datasetId)) {
    return { unsupported: `format ${format} is a triple file whose head and tail columns the catalogue does not record` };
  }
  if (format === "various" && download.innerPath === undefined && kind !== "none" && kind !== "gzip") {
    return { unsupported: "an archive in format various, whose member and format the catalogue does not record" };
  }
  const innerExtension = download.innerPath === undefined ? undefined : /\.[^./]+$/.exec(download.innerPath.toLowerCase())?.[0];
  const mapped = format === "various" ? (innerExtension === undefined ? "edge-list" : (VARIOUS_BY_EXTENSION.get(innerExtension) ?? "edge-list")) : (format === "tsv" || format === "txt") ? "edge-list" : PARSERS.get(format);
  if (mapped === undefined) {
    return { unsupported: `format ${format} has a pipeline-specific parser with no declarative keepset form yet` };
  }
  const flags: string[] = [];
  let parser: Parser;
  if (mapped === "linqs") {
    // LINQS .cites lines are "<cited> <citing>" (the dataset README: "the link is paper2->paper1"), so the edge runs from the second column to the first.
    parser = edgeList({ delimiter: "tab", sourceColumn: 1, targetColumn: 0 });
    flags.push("LINQS .cites column order: edges run from the citing paper (second column) to the cited one");
  } else if (mapped === "edge-list") {
    const override = PIPELINE_PARSER_OVERRIDES.get(datasetId);
    parser = edgeList({ ...(override?.delimiter === undefined ? {} : { delimiter: override.delimiter }), ...(override?.skipLines === undefined ? {} : { skipLines: override.skipLines }) });
    if (override?.delimiter !== undefined) {
      flags.push(`pipeline parser override: delimiter ${override.delimiter}`);
    }
    if (override?.skipLines !== undefined) {
      flags.push(`pipeline parser override: skip ${String(override.skipLines)} header line`);
    }
  } else if (mapped === "ucinet-dl") {
    parser = { format: mapped, encoding: "utf-8", matrix: 1 };
    flags.push("UCINet DL: the recipe reads the file's first matrix, the one the pipeline reads");
  } else if (mapped === "pajek") {
    // Pajek vertex numbers and keywords are ASCII, and labels (where non-ASCII text appears, often in a Windows code page) are not carried, so latin1, which decodes any byte, reads every Pajek file to the same graph.
    parser = { format: mapped, encoding: "latin1" };
  } else {
    parser = { format: mapped, encoding: "utf-8" };
  }

  if (kind === "none" || kind === "gzip" || kind === "bzip2") {
    return { url: download.url, archive: { kind }, parser, crosswalk: CROSSWALKS.topology, flags };
  }
  // SuiteSparse serves each matrix as /MM/<group>/<name>.tar.gz holding <name>/<name>.mtx.
  const suiteSparse = new URL(original).hostname === "sparse.tamu.edu" ? /^\/MM\/[^/]+\/([^/]+)\.tar\.gz$/.exec(new URL(original).pathname) : null;
  if (mapped === "gd-contest" && kind === "zip" && download.innerPath !== undefined) {
    // The GD 2004 contest bundle ships its problems in a zip inside the zip (GD04/challenge.zip), and the catalogue's inner path is the problem's path inside that inner zip.
    flags.push("GD contest bundle: the problem is read from the bundle's one inner .zip member, which the source catalogue does not record");

    return { url: download.url, archive: { kind, member: { extensions: [".zip"] }, inner: { kind: "zip", member: { path: download.innerPath } } }, parser, crosswalk: CROSSWALKS.topology, flags };
  }
  if (download.innerPath !== undefined) {
    return { url: download.url, archive: { kind, member: { path: download.innerPath } }, parser, crosswalk: CROSSWALKS.topology, flags };
  }
  if (mapped === "matrix-market" && kind === "tar.gz" && suiteSparse?.[1] !== undefined) {
    const name = suiteSparse[1];
    flags.push("archive member derived from the SuiteSparse archive layout, <name>/<name>.mtx");

    return { url: download.url, archive: { kind, member: { path: `${name}/${name}.mtx` } }, parser, crosswalk: CROSSWALKS.topology, flags };
  }
  const extensions = format === "edges" || new URL(original).hostname === "nrvis.com" ? [".edges"] : MEMBER_EXTENSIONS[mapped];
  flags.push(`archive member chosen by extension ${extensions.join(" or ")}, which the source catalogue does not record`);

  return { url: download.url, archive: { kind, member: { extensions: [...extensions] } }, parser, crosswalk: CROSSWALKS.topology, flags };
}

/**
 * The CSV download Netzschleuder publishes beside a network's landing page or graph-tool file: `<collection>/files/<network>.csv.zip`, whose `edges.csv` has a `# source, target, ...` header. The pipeline routes every Netzschleuder download to its own graph-tool reader whatever the preferred format says; keepset reads the CSV form instead.
 * @param url - A Netzschleuder landing page or `.gt.zst` URL.
 * @returns The CSV archive URL.
 */
export function netzschleuderCsv(url: string): string {
  const parsed = new URL(url);
  const path = parsed.pathname.replace(/\/$/, "");
  if (path.endsWith(".gt.zst")) {
    return `${parsed.origin}${path.slice(0, -".gt.zst".length)}.csv.zip`;
  }
  const network = path.split("/").at(-1);
  if (network === undefined || network === "") {
    throw new Error(`${url} names no Netzschleuder network`);
  }

  return `${parsed.origin}${path}/files/${network}.csv.zip`;
}

/**
 * Formats a structured citation as one reference string.
 * @param citation - The citation.
 * @returns The keepset citation.
 */
function formatCitation(citation: StructuredCitation): Citation {
  const parts = [`${citation.authors.join(", ")} (${String(citation.year)}). ${citation.title}.`];
  if (citation.journal !== undefined) {
    const volume = citation.volume === undefined ? "" : ` ${String(citation.volume)}${citation.number === undefined ? "" : `(${String(citation.number)})`}`;
    const pages = citation.pages === undefined ? "" : `, ${String(citation.pages)}`;
    parts.push(`${citation.journal}${volume}${pages}.`);
  }
  if (citation.publisher !== undefined) {
    parts.push(`${citation.publisher}.`);
  }
  const text = parts.join(" ");

  return citation.doi === undefined ? { text } : { text, doi: citation.doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "") };
}

/**
 * Converts the catalogue's citation record.
 * @param citation - The record.
 * @returns The keepset citations.
 */
function citationsOf(citation: SourceDataset["citation"]): Citation[] {
  if (citation === undefined || citation === null) {
    return [];
  }
  if (Array.isArray(citation)) {
    return citation.map(([text, url]) => {
      const doi = /^https?:\/\/(?:dx\.)?doi\.org\/(10\.\S+)$/.exec(url)?.[1];

      return doi === undefined ? { text, url } : { text, doi };
    });
  }

  return [formatCitation(citation)];
}

/**
 * Converts a snake_case property name to the camelCase key form entries use.
 * @param name - The catalogue's property name.
 * @returns The entry key.
 */
function camel(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase());
}

/** Catalogue property names whose camelCase form reads poorly or misleads, mapped to the entry key used instead. */
const PROPERTY_NAMES: ReadonlyMap<string, string> = new Map([
  ["is_directed", "directed"],
  ["is_weighted", "weighted"],
  ["is_heterogeneous", "heterogeneous"],
  ["is_multigraph", "multigraph"],
  ["is_connected", "connected"],
  ["is_cyclic", "cyclic"],
  ["has_self_loops", "selfLoops"],
  ["n_components", "components"],
  ["node_type_count", "nodeTypes"],
  ["edge_type_count", "edgeTypes"],
]);

/**
 * Converts the catalogue's structural properties and byte count into entry properties.
 * @param dataset - The dataset.
 * @returns The properties, keys sorted.
 * @throws Error when a property value is not a JSON scalar.
 */
function propertiesOf(dataset: SourceDataset): Record<string, JsonScalar> {
  const entries: [string, JsonScalar][] = [];
  for (const [name, value] of Object.entries(dataset.properties)) {
    if (!(value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))) {
      throw new Error(`${dataset.id}: property ${name} is not a JSON scalar`);
    }
    entries.push([PROPERTY_NAMES.get(name) ?? camel(name), value]);
  }
  if (dataset.rawBytes !== undefined) {
    entries.push(["rawBytes", dataset.rawBytes]);
  }

  return Object.fromEntries(entries.sort(([left], [right]) => (left < right ? -1 : 1)));
}

/**
 * Lists a dataset's downloads in catalogue order, flattening the source variants: a bare string is a landing page, and a cached-JSON record contributes its URLs.
 * @param sources - The catalogue's sources.
 * @returns Every download, synthetic ones included.
 */
function downloadsOf(sources: readonly SourceEntry[]): SourceDownload[] {
  return sources.flatMap((source): SourceDownload[] => {
    if (typeof source === "string") {
      return [{ url: source, format: "landing-page" }];
    }
    if ("downloads" in source) {
      return source.downloads;
    }

    return source.urls.map((url) => ({ url, format: source.format }));
  });
}

/**
 * The keepset source for a download URL: a snapshot URL becomes a dead source pinned to its timestamp, anything else a live one.
 * @param url - The download URL.
 * @param retrieved - The dataset's retrieval date.
 * @returns The source.
 */
function sourceFor(url: string, retrieved: string): Source {
  const snapshot = parseWayback(url);
  if (snapshot === undefined) {
    return { url, retrieved, status: "live" };
  }

  return { url: snapshot.original, retrieved, status: "dead", snapshot: { url: waybackUrl(snapshot.timestamp, snapshot.original), timestamp: snapshot.timestamp } };
}

/**
 * Names the pipeline catalogue gives two datasets alike, so a listing would show two identical rows. Each is replaced by the name followed by the collection it comes from in parentheses, the form the wormwiring entries already take. The pipeline catalogue is a read-only copy of an upstream file, so the replacement is made here and the import refuses one whose dataset is absent or already has that name.
 */
export const NAME_OVERRIDES: ReadonlyMap<string, string> = new Map([
  ["arenas-celegans-metabolic", "C. elegans Metabolic Network (Arenas)"],
  ["netzschleuder-celegans-metabolic", "C. elegans Metabolic Network (Netzschleuder)"],
  ["netzschleuder-florentine_families", "Padgett Florentine Families (Netzschleuder)"],
  ["ucinet-padgett", "Padgett Florentine Families (UCINET)"],
]);

/**
 * Converts one dataset.
 * @param dataset - The catalogue's dataset.
 * @param licences - Where each dataset's licence was read: the entry's licence is the one its curation records for the source its recipe fetches (its first source when it has no recipe).
 * @param nameOverrides - Replacement names by dataset id; a dataset not listed keeps the name the catalogue gives it.
 * @returns The entry, when the dataset converts, and its outcome for the report.
 */
export function convertDataset(dataset: SourceDataset, licences: Readonly<GraphLicenceResolver>, nameOverrides: ReadonlyMap<string, string> = NAME_OVERRIDES): { readonly entry?: Entry; readonly outcome: Outcome } {
  const { id } = dataset;
  const flags: string[] = [];
  const notConverted = (reason: string): { outcome: Outcome } => ({ outcome: { id, outcome: "not-converted", reason, flags } });
  if (dataset.sources === undefined || dataset.sources === null || dataset.sources.length === 0) {
    return notConverted("the source catalogue records no sources");
  }
  const all = downloadsOf(dataset.sources);
  if (all.some((download) => download.generator !== undefined)) {
    return notConverted("synthetic: generated by the pipeline, with no source to fetch");
  }
  if (all.every((download) => download.url === undefined)) {
    return notConverted("the source catalogue records no download URL");
  }
  const downloads: Download[] = [];
  for (const download of all) {
    const { url } = download;
    if (url === undefined) {
      return notConverted("a download records no URL");
    }
    if (url.startsWith("file:")) {
      flags.push("dropped a download that is a local file path, not a public source");
      continue;
    }
    if (!/^https?:\/\//.test(url)) {
      flags.push(`dropped a download with an unsupported scheme: ${url.slice(0, url.indexOf(":"))}`);
      continue;
    }
    if (AUTH_WALLED_HOSTS.has(new URL(url).hostname)) {
      flags.push(`dropped an auth-walled download at ${new URL(url).hostname}`);
      continue;
    }
    downloads.push({ url, format: download.format, innerPath: download.innerPath });
  }
  if (downloads.length === 0) {
    return notConverted("no public download remains: every download is auth-walled or a local file");
  }
  const retrieved = dataset.retrieved;
  if (retrieved === undefined || retrieved === null) {
    return notConverted("the source catalogue records no retrieval date, which every keepset source carries");
  }

  let chosen: Chosen | undefined;
  const unsupported: string[] = [];
  const netzschleuder = downloads.find((download) => download.format === "netzschleuder");
  if (netzschleuder !== undefined) {
    chosen = {
      url: netzschleuderCsv(netzschleuder.url),
      archive: { kind: "zip", member: { path: "edges.csv" } },
      parser: edgeList({ delimiter: "comma", commentPrefixes: ["#"] }),
      crosswalk: CROSSWALKS.topology,
      flags: ["Netzschleuder: the pipeline reads every Netzschleuder download with its graph-tool parser; the recipe reads the CSV archive derived from the catalogue's URL"],
    };
  } else {
    const ordered = [...downloads.filter((download) => download.format === dataset.preferredFormat), ...downloads.filter((download) => download.format !== dataset.preferredFormat)];
    for (const download of ordered) {
      const candidate = recipeFor(download, id);
      if ("unsupported" in candidate) {
        unsupported.push(`${download.format ?? "unrecorded format"}: ${candidate.unsupported}`);
        continue;
      }
      chosen = candidate;
      break;
    }
  }

  const urls = [...new Set([...downloads.map((download) => download.url), ...(chosen === undefined ? [] : [chosen.url])])];
  const sources = urls.map((url) => sourceFor(url, retrieved));
  let recipe: Recipe;
  if (chosen === undefined) {
    recipe = { status: "not-fetchable", reason: `no download is in a form keepset reads yet (${[...new Set(unsupported)].join("; ")})` };
    flags.push("not fetchable yet: no declarative recipe exists for any download");
  } else {
    flags.push(...chosen.flags);
    if (parseWayback(chosen.url) !== undefined) {
      flags.push("the source is dead and the recipe fetches its pinned Wayback snapshot");
    }
    recipe = { status: "fetchable", source: urls.indexOf(chosen.url), archive: chosen.archive, parser: chosen.parser };
  }

  const licenceSource = sources[recipe.status === "fetchable" ? recipe.source : 0];
  if (licenceSource === undefined) {
    throw new Error(`${id} has no source to read a licence from`);
  }
  const named = namespaceOf(id);
  const correction = CORRECTIONS.get(id);
  if (correction !== undefined) {
    flags.push(`corrected against the downloaded file: ${correction.reason}`);
  }
  const description = correction?.description ?? dataset.description;
  const entry = parseEntry({
    id,
    ...(named === undefined ? {} : { namespace: named.namespace, aliases: [named.alias] }),
    name: nameOverrides.get(id) ?? dataset.name,
    ...(description === undefined || description === "" ? {} : { description }),
    ...(dataset.domain === undefined ? {} : { domain: dataset.domain }),
    tags: dataset.category === undefined ? [] : [dataset.category],
    category: "graph/v1",
    sources,
    licence: licences.resolve(id, licenceSource.url),
    citations: citationsOf(dataset.citation),
    recipe,
    crosswalk: { file: chosen?.crosswalk ?? CROSSWALKS.topology },
    expectedCounts: { nodes: correction?.expectedNodes ?? dataset.nodeCount, edges: dataset.edgeCount },
    properties: { ...propertiesOf(dataset), ...correction?.properties },
  });

  return { entry, outcome: { id, outcome: flags.length === 0 ? "converted" : "converted-with-flags", recipe: recipe.status, flags } };
}

/** Where a pipeline dataset and a graphbox dataset describe the same data. */
export interface Overlap {
  readonly pipelineId: string;
  readonly graphboxId: string;
  readonly matchedBy: "id" | "download URL";
}

/**
 * Finds the graphbox datasets that overlap pipeline datasets, by identical id or a shared download URL, without merging them.
 * @param pipeline - The pipeline catalogue.
 * @param graphbox - The graphbox catalogue.
 * @returns Each overlapping pair, sorted by pipeline id then graphbox id.
 */
export function graphboxOverlap(pipeline: SourceCatalogue, graphbox: GraphboxCatalogue): Overlap[] {
  const urlsOf = (sources: readonly SourceEntry[] | null | undefined): Set<string> =>
    new Set(
      downloadsOf(sources ?? [])
        .map((download) => download.url)
        .filter((url) => url !== undefined),
    );
  const overlaps: Overlap[] = [];
  const graphboxDatasets = Object.values(graphbox.datasets).map((dataset) => ({ id: dataset.id, urls: urlsOf(dataset.sources) }));
  for (const dataset of Object.values(pipeline.datasets)) {
    const urls = urlsOf(dataset.sources);
    for (const other of graphboxDatasets) {
      if (other.id === dataset.id) {
        overlaps.push({ pipelineId: dataset.id, graphboxId: other.id, matchedBy: "id" });
      } else if ([...urls].some((url) => other.urls.has(url))) {
        overlaps.push({ pipelineId: dataset.id, graphboxId: other.id, matchedBy: "download URL" });
      }
    }
  }

  return overlaps.sort((left, right) => (left.pipelineId === right.pipelineId ? (left.graphboxId < right.graphboxId ? -1 : 1) : left.pipelineId < right.pipelineId ? -1 : 1));
}

/** The import report: the acceptance surface of a seed import. */
export interface Report {
  readonly source: { readonly catalogue: string; readonly version: string; readonly generated: string };
  readonly outcomes: readonly Outcome[];
  readonly judgementCallRemovals: typeof JUDGEMENT_CALL_REMOVALS;
  readonly omittedFields: typeof OMITTED_FIELDS;
  readonly graphboxOverlap: readonly Overlap[];
}

/**
 * Converts a whole catalogue.
 * @param pipeline - The pipeline catalogue.
 * @param graphbox - The graphbox catalogue, for the overlap section.
 * @param licences - The licence curation's resolver, checked for unused records once every dataset has converted.
 * @param nameOverrides - Replacement names by dataset id.
 * @returns The entries in id order and the report.
 * @throws Error when an override names a dataset the catalogue lacks or gives the name the dataset already has.
 */
export function convertCatalogue(pipeline: SourceCatalogue, graphbox: GraphboxCatalogue, licences: Readonly<GraphLicenceResolver>, nameOverrides: ReadonlyMap<string, string> = NAME_OVERRIDES): { readonly entries: readonly Entry[]; readonly report: Report } {
  for (const [id, name] of nameOverrides) {
    const dataset = Object.values(pipeline.datasets).find((candidate) => candidate.id === id);
    if (dataset === undefined) {
      throw new Error(`the name override for ${id} names no dataset of the catalogue`);
    }
    if (dataset.name === name) {
      throw new Error(`the name override for ${id} repeats the name the catalogue already gives it`);
    }
  }
  const entries: Entry[] = [];
  const outcomes: Outcome[] = [];
  for (const dataset of Object.values(pipeline.datasets).sort((left, right) => (left.id < right.id ? -1 : 1))) {
    const converted = convertDataset(dataset, licences, nameOverrides);
    if (converted.entry !== undefined) {
      entries.push(converted.entry);
    }
    outcomes.push(converted.outcome);
  }

  licences.assertAllUsed();

  return {
    entries,
    report: {
      source: { catalogue: "Mearman/Thesis experiments/pipeline/graphs/catalog.json", version: pipeline.version, generated: pipeline.generated },
      outcomes,
      judgementCallRemovals: JUDGEMENT_CALL_REMOVALS,
      omittedFields: OMITTED_FIELDS,
      graphboxOverlap: graphboxOverlap(pipeline, graphbox),
    },
  };
}
