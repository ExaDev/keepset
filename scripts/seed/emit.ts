/* What every seed import does with what it converted, shared so the imports differ only in what they read and convert: collect the files to write, find the entry files an earlier import wrote that this one no longer produces, and either write the lot or, in check mode, fail when the committed files are not exactly what the inputs produce. */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { type Entry, parseEntry } from "../../src/entry";
import { serialise } from "../../src/serialise";
import { pinSnapshots } from "../sources/entries";

/** What an import produces: every file it writes, by absolute path, and the entry files a previous import wrote that this one does not produce, which it removes. */
export interface Output {
  readonly writes: ReadonlyMap<string, string>;
  readonly stale: readonly string[];
}

/**
 * The files for a set of entries. An import does not know the snapshots `scripts/archive-sources.ts` pins on live sources, so an entry carries over the snapshot its committed file pins for any source URL it still lists without one; every other field is the import's.
 * @param entries - The entries.
 * @param entriesDir - The directory entry files live in.
 * @returns Each entry's file path mapped to its serialised text.
 */
export function entryWrites(entries: readonly Entry[], entriesDir: string): Map<string, string> {
  return new Map(
    entries.map((entry) => {
      const path = join(entriesDir, `${entry.id}.json`);
      const pinned = new Map<string, string>();
      if (existsSync(path)) {
        for (const source of parseEntry(JSON.parse(readFileSync(path, "utf8"))).sources) {
          if (source.snapshot !== undefined) {
            pinned.set(source.url, source.snapshot.timestamp);
          }
        }
      }

      return [path, serialise(pinSnapshots(entry, pinned))];
    }),
  );
}

/**
 * The ids an earlier report records as having an entry.
 * @param text - The earlier report file's text.
 * @param label - What to call the report in an error.
 * @param hasEntry - Whether an outcome record in the report produced an entry.
 * @returns The ids.
 * @throws Error when the report has no outcomes list.
 */
export function reportedIds(text: string, label: string, hasEntry: (outcome: Readonly<Record<string, unknown>>) => boolean): Set<string> {
  const doc: unknown = JSON.parse(text);
  if (typeof doc !== "object" || doc === null || !("outcomes" in doc) || !Array.isArray(doc.outcomes)) {
    throw new Error(`${label} has no outcomes list`);
  }
  const ids = new Set<string>();
  const outcomes: readonly unknown[] = doc.outcomes;
  for (const outcome of outcomes) {
    if (typeof outcome === "object" && outcome !== null && !Array.isArray(outcome) && "id" in outcome && typeof outcome.id === "string" && hasEntry(Object.fromEntries(Object.entries(outcome)))) {
      ids.add(outcome.id);
    }
  }

  return ids;
}

/**
 * The entry files an earlier import wrote that this one does not produce.
 * @param entriesDir - The directory entry files live in.
 * @param previous - The ids the earlier report records, or undefined when there is no earlier report.
 * @param produced - The ids this import produces.
 * @returns The paths to remove.
 */
export function staleEntries(entriesDir: string, previous: ReadonlySet<string> | undefined, produced: ReadonlySet<string>): string[] {
  return [...(previous ?? [])].filter((id) => !produced.has(id)).map((id) => join(entriesDir, `${id}.json`));
}

/**
 * Checks the committed files against an import's output, or writes them.
 * @param output - What the import produces.
 * @param repoRoot - The repository root, for paths in an error.
 * @param check - True to write nothing and fail on any difference.
 * @throws Error naming each differing or stale file when `check` is true and the committed files differ.
 */
export function apply(output: Output, repoRoot: string, check: boolean): void {
  if (check) {
    const differing = [...output.writes].filter(([path, text]) => !existsSync(path) || readFileSync(path, "utf8") !== text).map(([path]) => relative(repoRoot, path));
    const lingering = output.stale.filter((path) => existsSync(path)).map((path) => relative(repoRoot, path));
    if (differing.length > 0 || lingering.length > 0) {
      throw new Error(`the committed import output differs from what the inputs produce: ${[...differing, ...lingering.map((path) => `${path} (stale)`)].join(", ")}`);
    }

    return;
  }
  for (const [path, text] of output.writes) {
    writeFileSync(path, text, "utf8");
  }
  for (const path of output.stale) {
    rmSync(path, { force: true });
  }
}
