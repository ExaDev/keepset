import { createHash } from "node:crypto";
import { assertRoundTrip, encode, RoundTripMismatchError, type Crosswalk } from "crossmap";
import { getStreamedShape, isStreamable, type StreamableId } from "../categories";
import type { Dataset } from "../catalogue";
import type { Entry, Parser, Recipe } from "../entry";
import { KeepsetError, RecipeError, type RecipeStep } from "../errors";
import { TableReader } from "../parsers/csv-table";
import type { NativeRow } from "../parsers/native";
import { PieceDecoder } from "../parsers/parse-native";
import type { JsonScalar } from "../targets/json-scalar";
import { downloadRaw } from "./download";
import { IdSet } from "./id-set";
import { csvPages, type CsvPaging } from "./paged";
import type { FetchOptions, NodeSink, Provenance, RoundTripReport, StreamedDataset } from "./fetch-dataset";
import { metaOf, sourceRecord, sourceUrl, step } from "./recipe-run";

/** A streamed recipe, narrowed to the parts streaming reads. */
interface StreamedRecipe {
  readonly source: number;
  readonly paging: CsvPaging;
  readonly parser: Extract<Parser, { readonly format: "csv-table" }>;
}

/**
 * The parts of a recipe a stream reads, checked to be a streamed recipe: the entry schema refuses a `stream` recipe that is not a CSV paged source read by the csv-table parser with no archive, so this only fails for an entry whose recipe does not stream.
 * @param entry - The entry.
 * @returns The recipe's source, paging and parser, and the category.
 * @throws RecipeError when the recipe is not fetchable, does not stream, or its category has no streamed form.
 */
function streamedRecipe(entry: Entry): StreamedRecipe & { readonly category: StreamableId } {
  const { recipe, category } = entry;
  if (recipe.status === "not-fetchable") {
    throw new RecipeError(entry.id, "recipe", `the entry has no fetchable recipe: ${recipe.reason}`);
  }
  if (recipe.stream !== true) {
    throw new RecipeError(entry.id, "recipe", "the recipe is not streamed, so fetchDataset reads it as one document");
  }
  const { paging, parser } = recipe;
  if (paging === undefined || paging.kind === "arcgis-query" || parser.format !== "csv-table" || !isStreamable(category)) {
    throw new RecipeError(entry.id, "recipe", "a streamed recipe reads a CSV paged source through the csv-table parser, for a category with a streamed form");
  }

  return { source: recipe.source, paging, parser, category };
}

/**
 * Whether a recipe is streamed, so `fetchDataset` refuses it and `streamDataset` reads it.
 * @param recipe - A recipe.
 * @returns True for a streamed recipe.
 */
export function isStreamed(recipe: Recipe): boolean {
  return recipe.status === "fetchable" && recipe.stream === true;
}

/**
 * What a crosswalk path addresses, for the separability check: the document's meta, a field of every node, or anything else.
 * @param path - A crosswalk path.
 * @returns Its class.
 */
function pathClass(path: string): "meta" | "node" | "other" {
  if (path === "meta" || path.startsWith("meta.")) {
    return "meta";
  }

  return path === "nodes[]" || path.startsWith("nodes[].") ? "node" : "other";
}

/**
 * Why a crosswalk cannot be applied a page of nodes at a time, if it cannot: every rule must read and write the meta alone or one node's fields alone, with no `when`, so encoding a page's nodes under the document's meta gives exactly that page's part of encoding the whole document, and a round trip that holds on every page holds on the whole.
 * @param crosswalk - The crosswalk.
 * @returns The first rule that breaks this, described, or undefined when every rule keeps to it.
 */
export function inseparableRule(crosswalk: Crosswalk): string | undefined {
  for (const [index, rule] of [...crosswalk.rules, ...crosswalk.oneWay].entries()) {
    if ("when" in rule && rule.when !== undefined) {
      return `rule ${String(index)} (${rule.op}) has a when, which may read the whole document`;
    }
    const paths = ["from" in rule ? rule.from : undefined, "to" in rule ? rule.to : undefined].filter((path) => path !== undefined);
    const classes = new Set(paths.map(pathClass));
    const [only] = classes;
    if (classes.size !== 1 || only === "other") {
      return `rule ${String(index)} (${rule.op}) reads or writes ${paths.join(" and ")}, not the meta alone or one node's fields alone`;
    }
  }

  return undefined;
}

/**
 * Passes on what an async iterable yields, rethrowing its failure as a RecipeError naming the entry and the step, as `step` does for one call.
 * @param entryId - The entry.
 * @param name - The step.
 * @param source - What the step yields.
 * @returns The same items, in order.
 */
async function* inStep<Item>(entryId: string, name: RecipeStep, source: Readonly<AsyncIterable<Item>>): AsyncGenerator<Item, void, undefined> {
  try {
    yield* source;
  } catch (error) {
    if (error instanceof RecipeError) {
      throw error;
    }
    throw new RecipeError(entryId, name, error instanceof Error ? error.message : String(error), { cause: error });
  }
}

/** A recipe run as a stream of native rows: the meta the crosswalk receives with every page, the pages of rows, and the provenance of the bytes read so far, which is every byte once the pages are done. */
interface NativeStream {
  readonly meta: Record<string, JsonScalar>;
  readonly pages: AsyncGenerator<readonly NativeRow[], void, undefined>;
  readonly provenance: () => Provenance;
}

/**
 * Runs a streamed recipe's download and parse steps a page at a time: each page's bytes are hashed, decoded and read into rows, and then let go.
 * @param dataset - The dataset.
 * @param recipe - Its streamed recipe.
 * @param options - The network port, abort signal and clock.
 * @returns The stream.
 */
function openNative(dataset: Dataset, recipe: StreamedRecipe, options: FetchOptions): NativeStream {
  const { entry } = dataset;
  const { fetch: port = downloadRaw, signal, now = () => new Date() } = options;
  const source = entry.sources[recipe.source];
  if (source === undefined) {
    throw new RecipeError(entry.id, "recipe", `the recipe names source ${String(recipe.source)}, which the entry does not have`);
  }
  const fetchedUrl = sourceUrl(source);
  const retrievedAt = now().toISOString();
  const hash = createHash("sha256");
  let byteLength = 0;

  async function* pages(): AsyncGenerator<readonly NativeRow[], void, undefined> {
    const decoder = new PieceDecoder(recipe.parser);
    const reader = new TableReader(recipe.parser);
    for await (const page of inStep(entry.id, "download", csvPages(fetchedUrl, recipe.paging, port, signal))) {
      hash.update(page);
      byteLength += page.byteLength;
      const rows = await step(entry.id, "parse", () => reader.push(decoder.decode(page)));
      if (rows.length > 0) {
        yield rows;
      }
    }
    const rows = await step(entry.id, "parse", () => [...reader.push(decoder.end()), ...reader.end()]);
    if (rows.length > 0) {
      yield rows;
    }
  }

  return {
    meta: metaOf(entry),
    pages: pages(),
    // A copy of the running hash, so the provenance can be read part way and the hash still takes the pages after it.
    provenance: () => ({ entryId: entry.id, catalogue: dataset.catalogue, category: entry.category, source: sourceRecord(source), fetchedUrl, retrievedAt, sha256: hash.copy().digest("hex"), byteLength }),
  };
}

/**
 * The nodes of an encoded page: the crosswalk writes only the meta and the nodes, so the result is an object with a `nodes` array.
 * @param encoded - The crosswalk's output for a page.
 * @returns Its nodes.
 * @throws KeepsetError when the output is not an object with a nodes array and nothing beyond meta.
 */
function nodesOf(encoded: unknown): readonly unknown[] {
  if (typeof encoded !== "object" || encoded === null || Array.isArray(encoded) || !("nodes" in encoded) || !Array.isArray(encoded.nodes)) {
    throw new KeepsetError("the crosswalk's output is not an object with a nodes array");
  }
  const extra = Object.keys(encoded).filter((key) => key !== "meta" && key !== "nodes");
  if (extra.length > 0) {
    throw new KeepsetError(`the crosswalk's output has ${extra.join(", ")} beside meta and nodes`);
  }

  return encoded.nodes;
}

/**
 * Checks a crosswalk can run a page at a time, or fails the crosswalk step.
 * @param entry - The entry.
 * @param crosswalk - Its crosswalk.
 * @throws RecipeError when a rule reaches beyond the meta or one node's fields.
 */
function assertSeparable(entry: Entry, crosswalk: Crosswalk): void {
  const reason = inseparableRule(crosswalk);
  if (reason !== undefined) {
    throw new RecipeError(entry.id, "crosswalk", `a streamed crosswalk must apply to a page of nodes on its own: ${reason}`);
  }
}

/**
 * Streams a table, as `streamEntry` describes.
 * @param dataset - A dataset whose recipe streams.
 * @param sink - Where the meta and the nodes go.
 * @param options - The network port, abort signal and clock.
 * @returns The meta, the provenance, the node count and any count warnings, once every node has been handed on.
 * @throws RecipeError naming the entry and the failing step, after which the sink has had the nodes of the pages before the failure and no more; a recipe that does not stream, or a crosswalk that cannot run a page at a time, fails before anything is downloaded.
 */
export async function streamTable(dataset: Dataset, sink: NodeSink, options: FetchOptions): Promise<StreamedDataset> {
  const { entry, crosswalk } = dataset;
  const recipe = streamedRecipe(entry);
  assertSeparable(entry, crosswalk);
  const shape = getStreamedShape(recipe.category);
  const native = openNative(dataset, recipe, options);
  const meta = await step(entry.id, "validate", async () => {
    const encoded: unknown = await step(entry.id, "crosswalk", () => encode(crosswalk, { meta: native.meta, nodes: [] }));
    const parsed = shape.meta.safeParse(typeof encoded === "object" && encoded !== null && !Array.isArray(encoded) && "meta" in encoded ? encoded.meta : undefined);
    if (!parsed.success) {
      throw new KeepsetError(`the result's meta is not ${entry.category} meta: ${parsed.error.issues.map((issue) => `${["meta", ...issue.path.map(String)].join(".")}: ${issue.message}`).join("; ")}`);
    }

    return parsed.data;
  });
  await sink.meta(meta);
  const ids = new IdSet();
  for await (const rows of native.pages) {
    const offset = ids.size;
    const encoded = await step(entry.id, "crosswalk", () => nodesOf(encode(crosswalk, { meta: native.meta, nodes: rows })));
    const nodes = await step(entry.id, "validate", () =>
      encoded.map((candidate, index) => {
        const parsed = shape.node.safeParse(candidate);
        if (!parsed.success) {
          throw new KeepsetError(`the result is not ${entry.category}: ${parsed.error.issues.map((issue) => `${["nodes", String(offset + index), ...issue.path.map(String)].join(".")}: ${issue.message}`).join("; ")}`);
        }
        if (!ids.add(parsed.data.id)) {
          throw new KeepsetError(`the result is not ${entry.category}: nodes.${String(offset + index)}.id: duplicate node id ${JSON.stringify(parsed.data.id)}`);
        }

        return parsed.data;
      }),
    );
    await sink.nodes(nodes);
  }
  const counts = new Map([["nodes", ids.size]]);
  const warnings = Object.entries(entry.expectedCounts)
    .filter(([key, expected]) => counts.get(key) !== expected)
    .map(([key, expected]) => `${key}: the entry records ${String(expected)}, the fetched result has ${String(counts.get(key))}`);

  return { dataset, meta, provenance: native.provenance(), counts, warnings };
}

/**
 * Checks a streamed dataset's crosswalk on its real data a page at a time: crossmap's `assertRoundTrip` on the meta alone and then on each page's rows under the meta. The crosswalk applies to a page on its own, so the round trip holds on the whole table exactly when it holds on every page. It stops at the first page that differs and reports the path in the whole document.
 * @param dataset - A dataset whose recipe streams.
 * @param options - The network port, abort signal and clock.
 * @returns Whether the round trip holds, and where it first differs when it does not, with the provenance of the bytes it was checked on: every byte when it holds, those read up to the page that differs when it does not.
 * @throws RecipeError naming the entry and the failing step when the recipe fails before the comparison or the crosswalk cannot run.
 */
export async function roundTripTable(dataset: Dataset, options: FetchOptions): Promise<RoundTripReport> {
  const { entry, crosswalk } = dataset;
  const recipe = streamedRecipe(entry);
  assertSeparable(entry, crosswalk);
  const native = openNative(dataset, recipe, options);
  const check = (nodes: readonly NativeRow[], offset: number): RoundTripReport | undefined => {
    try {
      assertRoundTrip(crosswalk, [{ meta: native.meta, nodes }]);
    } catch (error) {
      if (error instanceof RoundTripMismatchError) {
        const path = error.path.replace(/^nodes\[(\d+)\]/, (_, index: string) => `nodes[${String(offset + Number(index))}]`);

        return { holds: false, path, message: error.message.replaceAll(error.path, path), provenance: native.provenance() };
      }
      throw new RecipeError(entry.id, "crosswalk", error instanceof Error ? error.message : String(error), { cause: error });
    }

    return undefined;
  };
  const metaMismatch = check([], 0);
  if (metaMismatch !== undefined) {
    return metaMismatch;
  }
  let offset = 0;
  for await (const rows of native.pages) {
    const mismatch = check(rows, offset);
    if (mismatch !== undefined) {
      await native.pages.return();

      return mismatch;
    }
    offset += rows.length;
  }

  return { holds: true, provenance: native.provenance() };
}
