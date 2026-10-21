/* The size and shape of a dataset as the listing shows it: node, edge and instance counts and the source's byte size, read from an entry's recorded counts and properties. Shared by the generator (the search index and the static table) and the client island, so both views of the listing agree on what is known and how it is written. */

import type { Entry } from "keepset";

/** The recorded dimensions of one entry; a field the entry does not record is absent, never zero. */
export interface Dimensions {
  readonly nodes?: number;
  readonly edges?: number;
  readonly instances?: number;
  readonly bytes?: number;
}

/**
 * Reads an entry's dimensions. `properties.rawBytes` is the size the source catalogue states and is `0` where it stated none, so a zero is no size and is left out.
 * @param entry - The entry.
 * @returns The dimensions the entry records.
 */
export function dimensionsOf(entry: Entry): Dimensions {
  const { expectedCounts, properties } = entry;
  const bytes = properties["rawBytes"];

  return {
    ...(expectedCounts["nodes"] === undefined ? {} : { nodes: expectedCounts["nodes"] }),
    ...(expectedCounts["edges"] === undefined ? {} : { edges: expectedCounts["edges"] }),
    ...(expectedCounts["instances"] === undefined ? {} : { instances: expectedCounts["instances"] }),
    ...(typeof bytes === "number" && bytes > 0 ? { bytes } : {}),
  };
}

/**
 * Writes a count with its digits grouped.
 * @param count - The count, or undefined where the entry records none.
 * @returns The text; empty for an unrecorded count.
 */
export function formatCount(count: number | undefined): string {
  return count === undefined ? "" : count.toLocaleString("en-GB");
}

/** Bytes in the next unit up of the binary prefixes, and the units' names from the smallest. */
const BYTES_PER_UNIT = 1024;
const UNITS = ["B", "KiB", "MiB", "GiB", "TiB"] as const;

/**
 * Writes a byte size in the largest binary unit it reaches, to one decimal place.
 * @param bytes - The size, or undefined where the entry records none.
 * @returns The text; empty for an unrecorded size.
 */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) {
    return "";
  }
  const unit = Math.min(UNITS.length - 1, Math.floor(Math.log(Math.max(bytes, 1)) / Math.log(BYTES_PER_UNIT)));

  return `${(bytes / BYTES_PER_UNIT ** unit).toLocaleString("en-GB", { maximumFractionDigits: 1 })} ${UNITS[unit] ?? "B"}`;
}
