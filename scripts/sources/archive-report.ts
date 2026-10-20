/* The committed record of the sources the Wayback Machine cannot hold, one exception per URL with the reason. `archive-sources.ts --check` accepts a source without a snapshot only when this report lists it, so every source is either pinned or accounted for. */

import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { canonicalJson } from "../../src/serialise";

/**
 * Why a source cannot be pinned:
 * - `size-limit`: the file is larger than Save Page Now captures.
 * - `excluded`: the Internet Archive refuses the URL (a robots exclusion or its own block list).
 * - `access-wall`: the host answers a visitor with a login, a bot wall or a refusal (401, 403), so no capture holds the data.
 * - `paged-api`: a recipe reads the URL as a paged query, so a capture of the URL alone is the first page and not the data.
 * - `source-error`: the host answers with an error, does not resolve, or serves a certificate no client accepts, so there is nothing to capture.
 */
export const EXCEPTION_REASONS = ["size-limit", "excluded", "access-wall", "paged-api", "source-error"] as const;
export type ExceptionReason = (typeof EXCEPTION_REASONS)[number];

/** One source the archive cannot hold: the URL, the entries that list it, the reason, and the observation the reason rests on (a status, an error code, a length or a paging kind). */
export const ArchiveExceptionSchema = z
  .object({
    url: z.url(),
    entries: z.array(z.string().min(1)).min(1),
    reason: z.enum(EXCEPTION_REASONS),
    evidence: z.string().min(1),
  })
  .strict();
export type ArchiveException = z.infer<typeof ArchiveExceptionSchema>;

const ReportSchema = z.object({ exceptions: z.array(ArchiveExceptionSchema) }).strict();

/**
 * The report file's text: the exceptions sorted by URL, in the committed JSON form.
 * @param exceptions - The exceptions.
 * @returns The file text.
 */
export function reportText(exceptions: readonly ArchiveException[]): string {
  return canonicalJson({ exceptions: [...exceptions].sort((left, right) => (left.url < right.url ? -1 : 1)) });
}

/**
 * Reads the committed report.
 * @param path - The report file.
 * @returns Its exceptions; none when the file does not exist yet.
 * @throws The schema's error when the file does not have the report's shape.
 */
export function readReport(path: string): ArchiveException[] {
  return existsSync(path) ? ReportSchema.parse(JSON.parse(readFileSync(path, "utf8"))).exceptions : [];
}
