import { type Entry, rawSnapshotUrl, type Source } from "./entry";
import { KeepsetError, RecipeError, type RecipeStep } from "./errors";
import type { JsonScalar } from "./targets/json-scalar";
import type { Download } from "./fetch";

/**
 * The URL a recipe downloads a source from, as `downloadUrl` gives it. A dead source is fetched from its pinned snapshot in the Wayback Machine's `id_` form, which serves the archived bytes as they were captured rather than wrapped in the archive's page chrome.
 * @param source - The source.
 * @returns The URL to request.
 */
export function sourceUrl(source: Source): string {
  if (source.status === "dead") {
    if (source.snapshot === undefined) {
      // The entry schema requires a snapshot on every dead source, so a parsed entry never reaches this.
      throw new KeepsetError(`dead source ${source.url} has no snapshot`);
    }

    return rawSnapshotUrl(source.snapshot.timestamp, source.url);
  }

  return source.url;
}

/**
 * The source record a provenance carries: the entry's source as recorded.
 * @param source - The source.
 * @returns Its URL, status and any snapshot.
 */
export function sourceRecord(source: Source): Download["source"] {
  return { url: source.url, status: source.status, ...(source.snapshot === undefined ? {} : { snapshot: source.snapshot }) };
}

/**
 * Runs one step, rethrowing any failure as a RecipeError naming the entry and the step, with the original error as its cause.
 * @param entryId - The entry.
 * @param name - The step.
 * @param run - The step's work.
 * @returns What the step returns.
 */
export async function step<Result>(entryId: string, name: RecipeStep, run: () => Result | Promise<Result>): Promise<Result> {
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
export function metaOf(entry: Entry): Record<string, JsonScalar> {
  return { id: entry.id, name: entry.name, ...entry.properties };
}
