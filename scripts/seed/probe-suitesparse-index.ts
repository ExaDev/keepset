/* Records the kind the SuiteSparse Matrix Collection's index states for each matrix the pipeline catalogue downloads from it.

   pnpm exec tsx scripts/seed/probe-suitesparse-index.ts [--pipeline <catalog.json>]

   --pipeline defaults to the committed copy in scripts/seed/sources/. The collection's index page is requested once, through the polite client, and each matrix's kind is written to scripts/seed/sources/suitesparse-index.json, which the import reads and `seed:check` verifies the entries against. A matrix the index page does not list is left out and named. */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { canonicalJson } from "../../src/serialise";
import { HTTP_STATUS } from "../sources/http-status";
import { systemClock } from "../sources/pacing";
import { DEFAULT_POLITENESS, PoliteClient } from "../sources/polite-client";
import { suiteSparsePaths } from "./mirror";
import { SourceCatalogueSchema } from "./source";
import { matrixKey, parseIndexKinds, SuiteSparseIndexSchema } from "./suitesparse-index";

/** The length of the `YYYY-MM-DD` prefix of an ISO 8601 timestamp. */
const ISO_DATE_LENGTH = "YYYY-MM-DD".length;
const INDEX_URL = "https://sparse.tamu.edu/?per_page=All";
/** The index page is one document of every matrix, generated per request and streamed slowly, so the request is given longer than the polite client's default to arrive. */
const INDEX_TIMEOUT_MILLISECONDS = 600_000;
const sourcesDir = join(dirname(fileURLToPath(import.meta.url)), "sources");
const { values } = parseArgs({ options: { pipeline: { type: "string" } }, strict: true });
const catalogue = SourceCatalogueSchema.parse(JSON.parse(readFileSync(values.pipeline ?? join(sourcesDir, "pipeline-catalog.json"), "utf8")));

const client = new PoliteClient(fetch, systemClock, { ...DEFAULT_POLITENESS, timeoutMilliseconds: INDEX_TIMEOUT_MILLISECONDS });
const page = await client.request(INDEX_URL);
if (page.status !== HTTP_STATUS.ok) {
  throw new Error(`${INDEX_URL} answered ${String(page.status)}`);
}
const listed = parseIndexKinds(await page.text());

const kinds: Record<string, string> = {};
const unlisted: string[] = [];
for (const path of suiteSparsePaths(catalogue)) {
  const key = matrixKey(path);
  const kind = key === undefined ? undefined : listed.get(key);
  if (key === undefined || kind === undefined) {
    unlisted.push(path);
  } else {
    kinds[key] = kind;
  }
}

const today = new Date(systemClock.now()).toISOString().slice(0, ISO_DATE_LENGTH);
writeFileSync(join(sourcesDir, "suitesparse-index.json"), canonicalJson(SuiteSparseIndexSchema.parse({ readOn: today, kinds })));
console.log(`${String(Object.keys(kinds).length)} matrices have a kind; not listed on the index page:\n${unlisted.join("\n")}`);
