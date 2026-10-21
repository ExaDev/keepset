import { z } from "zod";
import { HttpUrlSchema } from "../../src/entry";

/* A SuiteSparse download can be fetched from the University of Florida host that served the collection before it moved to Texas A&M, which holds byte-identical copies of most of its files. Its holdings are fixed (matrices added since are absent), so the import cannot assume a given file is there: the files it holds are recorded in scripts/seed/sources/suitesparse-mirror.json, written by scripts/seed/probe-suitesparse-mirror.ts, and the import offers the mirror's copy ahead of the collection's own link for each file the inventory lists. */

/** The mirror inventory: the host the files live under, the day they were probed, and the `MM/<group>/<name>.tar.gz` paths found there. */
export const SuiteSparseMirrorSchema = z
  .object({
    readOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: "must be a date, YYYY-MM-DD" }),
    host: HttpUrlSchema.refine((host) => host.endsWith("/"), { message: "must end with a slash" }),
    holds: z.array(z.string().regex(/^MM\/[^/]+\/[^/]+\.tar\.gz$/)),
  })
  .strict();
export type SuiteSparseMirror = z.infer<typeof SuiteSparseMirrorSchema>;

/** The origin the collection's download links name, which the pipeline catalogue records. */
export const SUITESPARSE_ORIGIN = "https://sparse.tamu.edu/";

/**
 * The path of a SuiteSparse Matrix Market download under a host.
 * @param url - A URL.
 * @param host - The host prefix to read it under, ending in a slash.
 * @returns The `MM/<group>/<name>.tar.gz` path, or undefined when the URL is not such a download under that host.
 */
export function matrixMarketPath(url: string, host: string): string | undefined {
  if (!url.startsWith(host)) {
    return undefined;
  }
  const path = url.slice(host.length);

  return /^MM\/[^/]+\/[^/]+\.tar\.gz$/.test(path) ? path : undefined;
}

/**
 * The mirror's copy of a SuiteSparse download.
 * @param mirror - The inventory.
 * @param url - A download URL from the catalogue.
 * @returns The URL of the mirror's copy, or undefined when the URL is not a SuiteSparse Matrix Market download or the mirror does not hold it.
 */
export function mirrorUrl(mirror: SuiteSparseMirror, url: string): string | undefined {
  const path = matrixMarketPath(url, SUITESPARSE_ORIGIN);

  return path !== undefined && mirror.holds.includes(path) ? `${mirror.host}${path}` : undefined;
}
