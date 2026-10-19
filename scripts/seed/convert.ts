import { parseEntry, waybackUrl, type Archive, type Citation, type Entry, type Parser, type Recipe, type Source } from "../../src/entry";
import type { JsonScalar } from "../../src/targets/json-scalar";
import type { GraphboxCatalogue, SourceCatalogue, SourceDataset, SourceDownload, SourceEntry, StructuredCitation } from "./source";

/** The shared crosswalk every converted entry uses: all keepset parsers emit the same native topology. */
export const TOPOLOGY_CROSSWALK = "crosswalks/graph-v1/topology.json";

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
    [".bz2", "bzip2"],
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

/** The keepset parser each catalogue format reads with, by the pipeline's own dispatch (`_fetch_content_for_format`): formats whose pipeline parser is the generic edge list, GML, Pajek or Matrix Market reader. */
/** The parser formats that read a graph, which are the ones the graph import maps a source's format to. */
type GraphFormat = Exclude<Parser["format"], "csv-table" | "geojson">;

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
]);

/** The file extensions each parser's member carries, for an archive whose member the catalogue does not name. */
const MEMBER_EXTENSIONS: Readonly<Record<GraphFormat | "linqs", readonly string[]>> = {
  "matrix-market": [".mtx"],
  gml: [".gml"],
  pajek: [".net", ".paj"],
  "edge-list": [".txt"],
  linqs: [".cites"],
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
  if (format === undefined) {
    return { unsupported: "the download records no format" };
  }
  if (format === "landing-page") {
    return { unsupported: "a landing page, not a download" };
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
  } else if (mapped === "pajek") {
    // Pajek vertex numbers and keywords are ASCII, and labels (where non-ASCII text appears, often in a Windows code page) are not carried, so latin1, which decodes any byte, reads every Pajek file to the same graph.
    parser = { format: mapped, encoding: "latin1" };
  } else {
    parser = { format: mapped, encoding: "utf-8" };
  }

  if (kind === "none" || kind === "gzip") {
    return { url: download.url, archive: { kind }, parser, flags };
  }
  // SuiteSparse serves each matrix as /MM/<group>/<name>.tar.gz holding <name>/<name>.mtx.
  const suiteSparse = new URL(original).hostname === "sparse.tamu.edu" ? /^\/MM\/[^/]+\/([^/]+)\.tar\.gz$/.exec(new URL(original).pathname) : null;
  if (download.innerPath !== undefined) {
    return { url: download.url, archive: { kind, member: { path: download.innerPath } }, parser, flags };
  }
  if (mapped === "matrix-market" && kind === "tar.gz" && suiteSparse?.[1] !== undefined) {
    const name = suiteSparse[1];
    flags.push("archive member derived from the SuiteSparse archive layout, <name>/<name>.mtx");

    return { url: download.url, archive: { kind, member: { path: `${name}/${name}.mtx` } }, parser, flags };
  }
  const extensions = format === "edges" || new URL(original).hostname === "nrvis.com" ? [".edges"] : MEMBER_EXTENSIONS[mapped];
  flags.push(`archive member chosen by extension ${extensions.join(" or ")}, which the source catalogue does not record`);

  return { url: download.url, archive: { kind, member: { extensions: [...extensions] } }, parser, flags };
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
 * Converts one dataset.
 * @param dataset - The catalogue's dataset.
 * @returns The entry, when the dataset converts, and its outcome for the report.
 */
export function convertDataset(dataset: SourceDataset): { readonly entry?: Entry; readonly outcome: Outcome } {
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

  const named = namespaceOf(id);
  const entry = parseEntry({
    id,
    ...(named === undefined ? {} : { namespace: named.namespace, aliases: [named.alias] }),
    name: dataset.name,
    ...(dataset.description === undefined || dataset.description === "" ? {} : { description: dataset.description }),
    ...(dataset.domain === undefined ? {} : { domain: dataset.domain }),
    tags: dataset.category === undefined ? [] : [dataset.category],
    category: "graph/v1",
    sources,
    licence: { kind: "unrecorded" },
    citations: citationsOf(dataset.citation),
    recipe,
    crosswalk: { file: TOPOLOGY_CROSSWALK },
    expectedCounts: { nodes: dataset.nodeCount, edges: dataset.edgeCount },
    properties: propertiesOf(dataset),
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
 * @returns The entries in id order and the report.
 */
export function convertCatalogue(pipeline: SourceCatalogue, graphbox: GraphboxCatalogue): { readonly entries: readonly Entry[]; readonly report: Report } {
  const entries: Entry[] = [];
  const outcomes: Outcome[] = [];
  for (const dataset of Object.values(pipeline.datasets).sort((left, right) => (left.id < right.id ? -1 : 1))) {
    const converted = convertDataset(dataset);
    if (converted.entry !== undefined) {
      entries.push(converted.entry);
    }
    outcomes.push(converted.outcome);
  }

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
