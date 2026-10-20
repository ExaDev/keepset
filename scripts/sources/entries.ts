/* The catalogue's entry files as the source scripts see them: every source URL grouped across the entries that record it, and the one edit the archiver makes, pinning a snapshot on a source that has none. */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Entry, parseEntry, type Snapshot, waybackUrl } from "../../src/entry";
import { serialise } from "../../src/serialise";

/** An entry and the file that holds it. */
export interface EntryFile {
  readonly path: string;
  readonly entry: Entry;
}

/**
 * Reads every entry file of a directory, in file name order. A file must already be in canonical form (the bytes `serialise` writes for its parsed value), which is what lets an edit made through `serialise` change nothing but the edit.
 * @param dir - The directory of `<id>.json` entry files.
 * @returns The entries with their paths.
 * @throws Error naming a file that is not in canonical form, and the schema's error for one that does not parse.
 */
export function loadEntryFiles(dir: string): EntryFile[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const path = join(dir, name);
      const text = readFileSync(path, "utf8");
      const entry = parseEntry(JSON.parse(text));
      if (serialise(entry) !== text) {
        throw new Error(`${path} is not in canonical form: rewrite it as serialise() writes it before this script edits it`);
      }

      return { path, entry };
    });
}

/** One source URL and everything the catalogue records about it. */
export interface SourceGroup {
  readonly url: string;
  /** The ids of the entries that list the URL as a source, sorted. */
  readonly entryIds: readonly string[];
  /** The latest snapshot any of those entries pins for the URL, when one does. */
  readonly snapshot: Snapshot | undefined;
  /** Whether a recipe reads the URL as a paged query, so the URL alone is not the data. */
  readonly paged: boolean;
  /** Whether some entry lists the URL as a source without a snapshot. */
  readonly unpinned: boolean;
  /** Whether some entry records the URL as `live`; false when every entry records it `dead`. */
  readonly live: boolean;
}

/**
 * Groups the sources of every entry by URL.
 * @param files - The entry files.
 * @returns One group per distinct URL, sorted by URL.
 */
export function groupSources(files: readonly EntryFile[]): SourceGroup[] {
  const groups = new Map<string, { entryIds: Set<string>; snapshot: Snapshot | undefined; paged: boolean; unpinned: boolean; live: boolean }>();
  for (const { entry } of files) {
    entry.sources.forEach((source, index) => {
      const group = groups.get(source.url) ?? { entryIds: new Set<string>(), snapshot: undefined, paged: false, unpinned: false, live: false };
      group.entryIds.add(entry.id);
      if (source.snapshot !== undefined && (group.snapshot === undefined || source.snapshot.timestamp > group.snapshot.timestamp)) {
        group.snapshot = source.snapshot;
      }
      group.paged ||= entry.recipe.status === "fetchable" && entry.recipe.source === index && entry.recipe.paging !== undefined;
      group.unpinned ||= source.snapshot === undefined;
      group.live ||= source.status === "live";
      groups.set(source.url, group);
    });
  }

  return [...groups]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([url, group]) => ({ url, entryIds: [...group.entryIds].sort(), snapshot: group.snapshot, paged: group.paged, unpinned: group.unpinned, live: group.live }));
}

/**
 * The snapshot of a URL at a timestamp, with its URL spelt as the entry schema requires.
 * @param timestamp - A Wayback timestamp.
 * @param url - The source URL.
 * @returns The snapshot.
 */
export function snapshotOf(timestamp: string, url: string): Snapshot {
  return { timestamp, url: waybackUrl(timestamp, url) };
}

/**
 * The entry with a snapshot pinned on each source that has none and whose URL has one in `snapshots`. A source that already pins a snapshot is never replaced, and no other field is touched.
 * @param entry - The entry.
 * @param snapshots - The timestamp to pin for each URL.
 * @returns The edited entry, or the same entry when nothing was pinned.
 */
export function pinSnapshots(entry: Entry, snapshots: ReadonlyMap<string, string>): Entry {
  const wanted = (source: Entry["sources"][number]): string | undefined => (source.snapshot === undefined ? snapshots.get(source.url) : undefined);
  if (!entry.sources.some((source) => wanted(source) !== undefined)) {
    return entry;
  }

  return {
    ...entry,
    sources: entry.sources.map((source) => {
      const timestamp = wanted(source);

      return timestamp === undefined ? source : { ...source, snapshot: snapshotOf(timestamp, source.url) };
    }),
  };
}

/**
 * Pins snapshots on the entry files that need them and writes only those files.
 * @param files - The entry files.
 * @param snapshots - The timestamp to pin for each URL.
 * @returns The files after the edit, and how many were written.
 */
export function recordSnapshots(files: readonly EntryFile[], snapshots: ReadonlyMap<string, string>): { files: EntryFile[]; written: number } {
  let written = 0;
  const edited = files.map((file) => {
    const entry = pinSnapshots(file.entry, snapshots);
    if (entry === file.entry) {
      return file;
    }
    writeFileSync(file.path, serialise(entry), "utf8");
    written += 1;

    return { path: file.path, entry };
  });

  return { files: edited, written };
}
