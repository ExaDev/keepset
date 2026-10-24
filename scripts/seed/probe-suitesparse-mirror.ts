/* Records which of the pipeline catalogue's SuiteSparse Matrix Market downloads the University of Florida mirror serves.

   pnpm exec tsx scripts/seed/probe-suitesparse-mirror.ts [--pipeline <catalog.json>]

   --pipeline defaults to the committed copy in scripts/seed/sources/. Every `https://sparse.tamu.edu/MM/<group>/<name>.tar.gz` download in it is requested from the mirror with a HEAD request through the polite client (paced per host), and the paths answering 200 are written to scripts/seed/sources/suitesparse-mirror.json, dated today. A path answering anything else is left out and reported with its status; a request that fails outright stops the run, since the inventory would otherwise silently shrink. */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { canonicalJson } from "../../src/serialise";
import { SuiteSparseMirrorSchema, suiteSparsePaths } from "./mirror";
import { SourceCatalogueSchema } from "./source";
import { HTTP_STATUS } from "../sources/http-status";
import { systemClock } from "../sources/pacing";
import { DEFAULT_POLITENESS, PoliteClient } from "../sources/polite-client";

/** The length of the `YYYY-MM-DD` prefix of an ISO 8601 timestamp. */
const ISO_DATE_LENGTH = "YYYY-MM-DD".length;
const MIRROR_HOST = "https://www.cise.ufl.edu/research/sparse/";
const sourcesDir = join(dirname(fileURLToPath(import.meta.url)), "sources");
const { values } = parseArgs({ options: { pipeline: { type: "string" } }, strict: true });
const catalogue = SourceCatalogueSchema.parse(JSON.parse(readFileSync(values.pipeline ?? join(sourcesDir, "pipeline-catalog.json"), "utf8")));

const wanted = suiteSparsePaths(catalogue);

const client = new PoliteClient(fetch, systemClock, DEFAULT_POLITENESS);
const holds: string[] = [];
const missing: string[] = [];
/**
 * Requests the remaining paths one after another, the client pacing them.
 * @param remaining - The paths not yet requested.
 */
async function probe(remaining: readonly string[]): Promise<void> {
  const [path, ...rest] = remaining;
  if (path === undefined) {
    return;
  }
  const response = await client.request(`${MIRROR_HOST}${path}`, { method: "HEAD" });
  if (response.status === HTTP_STATUS.ok) {
    holds.push(path);
  } else {
    missing.push(`${path} ${String(response.status)}`);
  }

  return probe(rest);
}
await probe(wanted);

const today = new Date(systemClock.now()).toISOString().slice(0, ISO_DATE_LENGTH);
const inventory = SuiteSparseMirrorSchema.parse({ readOn: today, host: MIRROR_HOST, holds: holds.sort() });
writeFileSync(join(sourcesDir, "suitesparse-mirror.json"), canonicalJson(inventory));
console.log(`${String(holds.length)} of ${String(wanted.length)} downloads are on the mirror; not served:\n${missing.sort().join("\n")}`);
