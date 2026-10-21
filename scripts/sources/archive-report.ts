/* The committed record of the archive: the sources the Wayback Machine cannot hold, one exception per URL with the reason, and the pins that have been requested back and served their bytes. `archive-sources.ts --check` accepts a source without a snapshot only when this report lists it, and a pin only when this report lists it as verified, so every source is either pinned and verified or accounted for. The record of verification is committed, not kept in the untracked state file, because `--check` must give the same answer on a clean checkout and in CI as on the machine that ran the verification. */

import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { WaybackTimestampSchema } from "../../src/entry";
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

/** A pin whose raw snapshot was requested and served the captured bytes: the source URL and the pinned timestamp. A pin that changes is a different pin, so a record never vouches for a timestamp it did not check. */
export const VerifiedPinSchema = z.object({ url: z.url(), timestamp: WaybackTimestampSchema }).strict();
export type VerifiedPin = z.infer<typeof VerifiedPinSchema>;

/** `verified` is absent from a report written before verification existed, which means exactly what an empty list means: nothing had been asked back. */
const ReportSchema = z.object({ exceptions: z.array(ArchiveExceptionSchema), verified: z.array(VerifiedPinSchema).default([]) }).strict();
export type Report = z.infer<typeof ReportSchema>;

/** The report of an archive nothing has been recorded about. */
export const EMPTY_REPORT: Report = { exceptions: [], verified: [] };

/**
 * The report file's text: the exceptions and the verified pins sorted by URL (then timestamp), in the committed JSON form.
 * @param report - The report.
 * @returns The file text.
 */
export function reportText(report: Readonly<Report>): string {
  return canonicalJson({
    exceptions: [...report.exceptions].sort((left, right) => (left.url < right.url ? -1 : 1)),
    verified: [...report.verified].sort((left, right) => (left.url === right.url ? (left.timestamp < right.timestamp ? -1 : 1) : left.url < right.url ? -1 : 1)),
  });
}

/**
 * Reads the committed report.
 * @param path - The report file.
 * @returns The report; an empty one when the file does not exist yet.
 * @throws The schema's error when the file does not have the report's shape.
 */
export function readReport(path: string): Report {
  return existsSync(path) ? ReportSchema.parse(JSON.parse(readFileSync(path, "utf8"))) : EMPTY_REPORT;
}
