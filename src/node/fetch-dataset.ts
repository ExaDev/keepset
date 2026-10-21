import { createHash } from "node:crypto";
import { assertRoundTrip, encode, RoundTripMismatchError } from "crossmap";
import { getDataset } from "../bundled";
import { countTarget, getCollectionTarget, getTarget, type CategoryTarget, type CollectionTarget } from "../categories";
import type { Dataset } from "../catalogue";
import { KeepsetError, RecipeError } from "../errors";
import type { NativeDocument } from "../parsers/native";
import { parseNative, parseNativeFiles, parseNativeParts } from "../parsers/parse-native";
import type { JsonScalar } from "../targets/json-scalar";
import { unpack, unpackFiles, unpackMembers, unpackParts, type Unpacked } from "./archive";
import { downloadRaw } from "./download";
import { downloadPaged } from "./paged";
import { metaOf, sourceRecord, sourceUrl, step } from "./recipe-run";
import { isStreamed, roundTripTable, streamTable } from "./stream-dataset";
import type { StreamableId, StreamedNodes } from "../categories";
import type { Entry, Snapshot, Source } from "../entry";

/** The network port a recipe downloads through: `downloadRaw` by default, which returns the bytes exactly as served, or a stand-in under test. */
export type FetchPort = (url: string, init: { readonly signal?: AbortSignal }) => Promise<Response>;

/** What a fetch may be given beyond the dataset: the network port, an abort signal and the clock that dates the provenance record. */
export interface FetchOptions {
  readonly fetch?: FetchPort;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
}

/** One download a result's bytes came from: the entry's source, the URL actually requested (the snapshot's for a dead source) and exactly which bytes arrived. */
export interface Download {
  readonly source: { readonly url: string; readonly status: Source["status"]; readonly snapshot?: Snapshot };
  readonly fetchedUrl: string;
  readonly sha256: string;
  readonly byteLength: number;
}

/** Where a fetched result's bytes came from: enough to say which entry, catalogue and source produced it, which URL was actually requested, when, and exactly which bytes arrived. */
export interface Provenance extends Download {
  readonly entryId: string;
  readonly catalogue: Dataset["catalogue"];
  readonly category: Entry["category"];
  readonly retrievedAt: string;
  /** The archive member a document was read from. */
  readonly member?: string;
  /** The archive members a collection, or a document read from several files, was read from, in the order they were read. */
  readonly members?: readonly string[];
}

/** Whether decoding a dataset's encoded native document gives the native document back, with the provenance of the bytes it was checked on. */
export type RoundTripReport = { readonly holds: true; readonly provenance: Provenance } | { readonly holds: false; readonly path: string; readonly message: string; readonly provenance: Provenance };

/** A node a streamed result hands on: a node of a streamable category's target. */
export type StreamedNode = StreamedNodes[StreamableId];

/** Where a streamed result goes: the meta once, before any node, then the nodes a page at a time, each already checked against the category's node shape and for an id no earlier node had. A sink that returns a promise is awaited before the next page is read, so a slow sink holds the stream back rather than letting pages pile up. */
export interface NodeSink {
  readonly meta: (meta: Readonly<Record<string, JsonScalar>>) => void | Promise<void>;
  readonly nodes: (nodes: readonly StreamedNode[]) => void | Promise<void>;
}

/** What a streamed fetch ends with, once every node has been handed on: the meta, the provenance of the bytes, how many nodes there were, and any warnings, such as a count that differs from the one the entry records. */
export interface StreamedDataset {
  readonly dataset: Dataset;
  readonly meta: Readonly<Record<string, JsonScalar>>;
  readonly provenance: Provenance;
  readonly counts: ReadonlyMap<string, number>;
  readonly warnings: readonly string[];
}

/**
 * The URL a recipe downloads a source from. A dead source is fetched from its pinned snapshot in the Wayback Machine's `id_` form, which serves the archived bytes as they were captured rather than wrapped in the archive's page chrome.
 * @param source - The source.
 * @returns The URL to request.
 */
export function downloadUrl(source: Source): string {
  return sourceUrl(source);
}

/** A fetched dataset: the resolved category target (one document, or for a recipe that selects archive members a collection of them), the provenance of the bytes it came from, and any warnings, such as a count that differs from the one the entry records. */
export interface FetchedDataset {
  readonly dataset: Dataset;
  readonly data: CategoryTarget | CollectionTarget;
  readonly provenance: Provenance;
  readonly warnings: readonly string[];
}

/** A native document with the `meta` the crosswalk receives. */
type NativeWithMeta = NativeDocument & { readonly meta: Record<string, JsonScalar> };

/** A recipe run up to the native documents, before the crosswalk: what both a fetch and a round-trip check start from. A document recipe has one, the parser's output with the entry's `meta` over the parser's own header values (a multi-file format's document among them, read from every file its archive selects); a collection recipe has one per archive member, named by the member's path, each the parser's output with only its own header values as `meta`, because the entry's metadata belongs to the collection and not to each instance. */
interface NativeRun {
  readonly collection: boolean;
  readonly documents: readonly { readonly id: string | undefined; readonly native: NativeWithMeta }[];
  readonly provenance: Provenance;
}

/**
 * Puts an instance's id beside the fields of its encoded document. A document that is not an object is left as it is, for the collection schema to refuse.
 * @param document - The crosswalk's output for one member.
 * @param id - The member's path.
 * @returns The instance.
 */
function withId(document: unknown, id: string | undefined): unknown {
  return typeof document === "object" && document !== null && !Array.isArray(document) ? { ...document, id } : document;
}

/**
 * Runs a recipe's download, extract and parse steps, and builds the native documents the crosswalk receives.
 * @param dataset - The dataset.
 * @param options - The network port, abort signal and clock.
 * @returns The native documents and the provenance of their bytes.
 */
async function runToNative(dataset: Dataset, options: FetchOptions): Promise<NativeRun> {
  const { entry } = dataset;
  const { fetch: fetchPort = downloadRaw, signal, now = () => new Date() } = options;
  const { recipe } = entry;
  if (recipe.status === "not-fetchable") {
    throw new RecipeError(entry.id, "recipe", `the entry has no fetchable recipe: ${recipe.reason}`);
  }
  if (recipe.stream === true) {
    throw new RecipeError(entry.id, "recipe", "the table is too large to hold as one document, so its recipe streams: read it with streamDataset, which hands its nodes on a page at a time");
  }
  const source = entry.sources[recipe.source];
  if (source === undefined) {
    throw new RecipeError(entry.id, "recipe", `the recipe names source ${String(recipe.source)}, which the entry does not have`);
  }
  const fetchedUrl = sourceUrl(source);

  const retrievedAt = now().toISOString();
  const bytes = await step(entry.id, "download", async () => {
    if (recipe.paging !== undefined) {
      return downloadPaged(fetchedUrl, recipe.paging, fetchPort, signal);
    }
    const response = await fetchPort(fetchedUrl, signal === undefined ? {} : { signal });
    if (!response.ok) {
      throw new KeepsetError(`${fetchedUrl} answered ${String(response.status)} ${response.statusText}`);
    }

    return new Uint8Array(await response.arrayBuffer());
  });
  const provenanceOf = (extra: Pick<Provenance, "member" | "members">): Provenance => ({
    entryId: entry.id,
    catalogue: dataset.catalogue,
    category: entry.category,
    source: sourceRecord(source),
    fetchedUrl,
    retrievedAt,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
    ...extra,
  });
  const { archive } = recipe;
  if ("members" in archive) {
    const files = await step(entry.id, "extract", () => unpackMembers(bytes, archive));
    const documents = await step(entry.id, "parse", () =>
      files.map((file) => {
        try {
          const parsed = parseNative(file.bytes, recipe.parser);

          return { id: file.path, native: { ...parsed, meta: "meta" in parsed ? parsed.meta : {} } };
        } catch (error) {
          throw new KeepsetError(`member ${file.path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        }
      }),
    );

    return { collection: true, documents, provenance: provenanceOf({ members: files.map((file) => file.path) }) };
  }
  if ("parts" in archive) {
    const parts = await step(entry.id, "extract", () => unpackParts(bytes, archive));
    const parsed = await step(entry.id, "parse", () => parseNativeParts(parts, recipe.parser));

    return { collection: false, documents: [{ id: undefined, native: { ...parsed, meta: metaOf(entry) } }], provenance: provenanceOf({ members: parts.map((part) => part.path) }) };
  }
  if ("files" in archive) {
    const files = await step(entry.id, "extract", () => unpackFiles(bytes, archive));
    const parsed = await step(entry.id, "parse", () => parseNativeFiles(files, recipe.parser));

    return { collection: false, documents: [{ id: undefined, native: { ...parsed, meta: metaOf(entry) } }], provenance: provenanceOf({ members: files.map((file) => file.path) }) };
  }
  const unpacked: Unpacked = await step(entry.id, "extract", () => unpack(bytes, archive));
  const parsed = await step(entry.id, "parse", () => parseNative(unpacked.bytes, recipe.parser));
  const native = { ...parsed, meta: { ...("meta" in parsed ? parsed.meta : {}), ...metaOf(entry) } };

  return { collection: false, documents: [{ id: undefined, native }], provenance: provenanceOf(unpacked.member === undefined ? {} : { member: unpacked.member }) };
}

/**
 * Runs a dataset's recipe: downloads the source (from its pinned snapshot when the source is dead), unpacks the archive, parses the native shape, applies the crossmap crosswalk and validates the result against the category target. The native document the crosswalk receives is the parser's output with `meta` built from the entry.
 * @param dataset - A dataset from any catalogue.
 * @param options - The network port, abort signal and clock.
 * @returns The resolved target with its provenance and any count warnings.
 * @throws RecipeError naming the entry and the failing step, including for a recipe that streams, which `streamEntry` reads; nothing partial or default-shaped is ever returned.
 */
export async function fetchEntry(dataset: Dataset, options: FetchOptions = {}): Promise<FetchedDataset> {
  const { entry, crosswalk } = dataset;
  const { collection, documents, provenance } = await runToNative(dataset, options);
  const encoded = await step(entry.id, "crosswalk", () =>
    documents.map(({ id, native }) => {
      try {
        return encode(crosswalk, native);
      } catch (error) {
        throw new KeepsetError(`${id === undefined ? "" : `member ${id}: `}${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    }),
  );
  const data = await step(entry.id, "validate", () => {
    const [only] = encoded;
    const whole = collection ? { meta: metaOf(entry), instances: encoded.map((document, index) => withId(document, documents[index]?.id)) } : only;
    const result = (collection ? getCollectionTarget(entry.category) : getTarget(entry.category)).safeParse(whole);
    if (!result.success) {
      throw new KeepsetError(`the result is not ${collection ? "a collection of " : ""}${entry.category}: ${result.error.issues.map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`).join("; ")}`);
    }

    return result.data;
  });

  const counts = countTarget(entry.category, data);
  const warnings = Object.entries(entry.expectedCounts)
    .filter(([key, expected]) => counts.get(key) !== expected)
    .map(([key, expected]) => `${key}: the entry records ${String(expected)}, the fetched result has ${String(counts.get(key))}`);

  return { dataset, data, provenance, warnings };
}

/**
 * Fetches a dataset of the bundled catalogue by id and resolves it to its category's target shape, so `fetchDataset("cora")` yields graph/v1 `{ meta, nodes, edges }` directly. Node-only: it downloads with Node's http and https clients and unpacks with Node's zlib.
 * @param id - The entry id.
 * @param options - The network port, abort signal and clock.
 * @returns The resolved target with its provenance and any count warnings.
 * @throws DatasetNotFoundError when no entry has that id, and RecipeError naming the entry and the failing step when the recipe fails.
 */
export async function fetchDataset(id: string, options: FetchOptions = {}): Promise<FetchedDataset> {
  return fetchEntry(getDataset(id), options);
}

/**
 * Checks a dataset's crosswalk on its real data: runs the recipe to the native document, then crossmap's `assertRoundTrip`, which encodes it, decodes the result and compares the two over every path the crosswalk promises to preserve. A streamed recipe is checked a page at a time, with the round trip holding on the whole table exactly when it holds on every page, so the table is never held.
 * @param dataset - A dataset from any catalogue.
 * @param options - The network port, abort signal and clock.
 * @returns Whether the round trip holds, and where it first differs when it does not.
 * @throws RecipeError naming the entry and the failing step when the recipe fails before the comparison, or when the crosswalk cannot run.
 */
export async function roundTripEntry(dataset: Dataset, options: FetchOptions = {}): Promise<RoundTripReport> {
  if (isStreamed(dataset.entry.recipe)) {
    return roundTripTable(dataset, options);
  }
  const { documents, provenance } = await runToNative(dataset, options);
  try {
    assertRoundTrip(
      dataset.crosswalk,
      documents.map(({ native }) => native),
    );
  } catch (error) {
    // A mismatch is the answer this check exists to give, so it becomes the report; any other failure is the crosswalk failing to run.
    if (error instanceof RoundTripMismatchError) {
      return { holds: false, path: error.path, message: error.message, provenance };
    }
    throw new RecipeError(dataset.entry.id, "crosswalk", error instanceof Error ? error.message : String(error), { cause: error });
  }

  return { holds: true, provenance };
}

/**
 * Streams a dataset of the bundled catalogue by id, as `streamEntry` does: for a table too large to hold as one document, whose recipe streams.
 * @param id - The entry id.
 * @param sink - Where the meta and the nodes go.
 * @param options - The network port, abort signal and clock.
 * @returns The meta, the provenance, the node count and any count warnings, once every node has been handed on.
 * @throws DatasetNotFoundError when no entry has that id, and RecipeError as `streamEntry` does.
 */
export async function streamDataset(id: string, sink: NodeSink, options: FetchOptions = {}): Promise<StreamedDataset> {
  return streamEntry(getDataset(id), sink, options);
}

/**
 * Streams a dataset whose table is too large to hold as one document: reads its paged source a page at a time, applies the crosswalk to each page's rows under the document's meta, checks the meta once and each node against the category's node shape and for an id no earlier node had, and hands the nodes on to the sink before reading the next page. What it holds at once is one page's bytes and rows and the ids seen so far (as bytes, not strings), never the table, so the result is the category target `{ meta, nodes }` delivered in order rather than held: the same nodes `fetchEntry` would give, checked by the same rules.
 * @param dataset - A dataset whose recipe streams.
 * @param sink - Where the meta and the nodes go.
 * @param options - The network port, abort signal and clock.
 * @returns The meta, the provenance, the node count and any count warnings, once every node has been handed on.
 * @throws RecipeError naming the entry and the failing step, after which the sink has had the nodes of the pages before the failure and no more; a recipe that does not stream, or a crosswalk that cannot run a page at a time, fails before anything is downloaded.
 */
export async function streamEntry(dataset: Dataset, sink: NodeSink, options: FetchOptions = {}): Promise<StreamedDataset> {
  return streamTable(dataset, sink, options);
}

/**
 * Runs `roundTripEntry` on a dataset of the bundled catalogue by id.
 * @param id - The entry id.
 * @param options - The network port, abort signal and clock.
 * @returns Whether the round trip holds.
 * @throws DatasetNotFoundError when no entry has that id, and RecipeError as `roundTripEntry` does.
 */
export async function roundTripDataset(id: string, options: FetchOptions = {}): Promise<RoundTripReport> {
  return roundTripEntry(getDataset(id), options);
}
