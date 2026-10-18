import { createHash } from "node:crypto";
import { encode } from "twindex";
import { getDataset } from "../bundled";
import { countTarget, getTarget, type CategoryTarget } from "../categories";
import type { Dataset } from "../catalogue";
import type { Entry, Snapshot, Source } from "../entry";
import { KeepsetError, RecipeError, type RecipeStep } from "../errors";
import { parseNative } from "../parsers/parse-native";
import type { JsonScalar } from "../targets/graph-v1";
import { unpack, type Unpacked } from "./archive";
import { downloadRaw } from "./download";

/** The network port a recipe downloads through: `downloadRaw` by default, which returns the bytes exactly as served, or a stand-in under test. */
export type FetchPort = (url: string, init: { readonly signal?: AbortSignal }) => Promise<Response>;

/** What a fetch may be given beyond the dataset: the network port, an abort signal and the clock that dates the provenance record. */
export interface FetchOptions {
  readonly fetch?: FetchPort;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
}

/** Where a fetched result's bytes came from: enough to say which entry, catalogue and source produced it, which URL was actually requested, when, and exactly which bytes arrived. */
export interface Provenance {
  readonly entryId: string;
  readonly catalogue: Dataset["catalogue"];
  readonly category: Entry["category"];
  readonly source: { readonly url: string; readonly status: Source["status"]; readonly snapshot?: Snapshot };
  readonly fetchedUrl: string;
  readonly retrievedAt: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly member?: string;
}

/** A fetched dataset: the resolved category target, the provenance of the bytes it came from, and any warnings, such as a count that differs from the one the entry records. */
export interface FetchedDataset {
  readonly dataset: Dataset;
  readonly data: CategoryTarget;
  readonly provenance: Provenance;
  readonly warnings: readonly string[];
}

/**
 * The URL a recipe downloads a source from. A dead source is fetched from its pinned snapshot in the Wayback Machine's `id_` form, which serves the archived bytes as they were captured rather than wrapped in the archive's page chrome.
 * @param source - The source.
 * @returns The URL to request.
 */
export function downloadUrl(source: Source): string {
  if (source.status === "dead") {
    if (source.snapshot === undefined) {
      // The entry schema requires a snapshot on every dead source, so a parsed entry never reaches this.
      throw new KeepsetError(`dead source ${source.url} has no snapshot`);
    }

    return `https://web.archive.org/web/${source.snapshot.timestamp}id_/${source.url}`;
  }

  return source.url;
}

/**
 * Runs one step, rethrowing any failure as a RecipeError naming the entry and the step, with the original error as its cause.
 * @param entryId - The entry.
 * @param name - The step.
 * @param run - The step's work.
 * @returns What the step returns.
 */
async function step<Result>(entryId: string, name: RecipeStep, run: () => Result | Promise<Result>): Promise<Result> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof RecipeError) {
      throw error;
    }
    throw new RecipeError(entryId, name, error instanceof Error ? error.message : String(error), { cause: error });
  }
}

/**
 * The metadata a fetched result starts from: the entry's id and name, then its recorded properties. The entry schema keeps `id` and `name` out of the properties, so neither can be overwritten.
 * @param entry - The entry.
 * @returns The meta record the crosswalk receives.
 */
function metaOf(entry: Entry): Record<string, JsonScalar> {
  return { id: entry.id, name: entry.name, ...entry.properties };
}

/**
 * Runs a dataset's recipe: downloads the source (from its pinned snapshot when the source is dead), unpacks the archive, parses the native shape, applies the twindex crosswalk and validates the result against the category target. The native document the crosswalk receives is the parser's output with `meta` built from the entry.
 * @param dataset - A dataset from any catalogue.
 * @param options - The network port, abort signal and clock.
 * @returns The resolved target with its provenance and any count warnings.
 * @throws RecipeError naming the entry and the failing step; nothing partial or default-shaped is ever returned.
 */
export async function fetchEntry(dataset: Dataset, options: FetchOptions = {}): Promise<FetchedDataset> {
  const { entry, crosswalk } = dataset;
  const { fetch: fetchPort = downloadRaw, signal, now = () => new Date() } = options;
  const { recipe } = entry;
  if (recipe.status === "not-fetchable") {
    throw new RecipeError(entry.id, "recipe", `the entry has no fetchable recipe: ${recipe.reason}`);
  }
  const source = entry.sources[recipe.source];
  if (source === undefined) {
    throw new RecipeError(entry.id, "recipe", `the recipe names source ${String(recipe.source)}, which the entry does not have`);
  }
  const fetchedUrl = downloadUrl(source);

  const retrievedAt = now().toISOString();
  const bytes = await step(entry.id, "download", async () => {
    const response = await fetchPort(fetchedUrl, signal === undefined ? {} : { signal });
    if (!response.ok) {
      throw new KeepsetError(`${fetchedUrl} answered ${String(response.status)} ${response.statusText}`);
    }

    return new Uint8Array(await response.arrayBuffer());
  });
  const unpacked: Unpacked = await step(entry.id, "extract", () => unpack(bytes, recipe.archive));
  const native = await step(entry.id, "parse", () => parseNative(unpacked.bytes, recipe.parser));
  const encoded = await step(entry.id, "crosswalk", () => encode(crosswalk, { meta: metaOf(entry), nodes: native.nodes, edges: native.edges }));
  const data = await step(entry.id, "validate", () => {
    const result = getTarget(entry.category).safeParse(encoded);
    if (!result.success) {
      throw new KeepsetError(`the result is not ${entry.category}: ${result.error.issues.map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`).join("; ")}`);
    }

    return result.data;
  });

  const counts = countTarget(entry.category, data);
  const warnings = Object.entries(entry.expectedCounts)
    .filter(([key, expected]) => counts.get(key) !== expected)
    .map(([key, expected]) => `${key}: the entry records ${String(expected)}, the fetched result has ${String(counts.get(key))}`);

  const provenance: Provenance = {
    entryId: entry.id,
    catalogue: dataset.catalogue,
    category: entry.category,
    source: { url: source.url, status: source.status, ...(source.snapshot === undefined ? {} : { snapshot: source.snapshot }) },
    fetchedUrl,
    retrievedAt,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
    ...(unpacked.member === undefined ? {} : { member: unpacked.member }),
  };

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
