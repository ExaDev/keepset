/* Records what the SuiteSparse Matrix Collection's index says about each matrix the pipeline catalogue downloads from it: its kind (the entry's domain) and, for each download the University of Florida mirror serves, the size of that download.

   pnpm exec tsx scripts/seed/probe-suitesparse-index.ts [--pipeline <catalog.json>]

   --pipeline defaults to the committed copy in scripts/seed/sources/. The collection's index page is requested once, and each download the committed mirror inventory (suitesparse-mirror.json) lists is requested from the mirror with a HEAD request, paced per host by the polite client, for its Content-Length. The result is written to scripts/seed/sources/suitesparse-index.json, which the import reads and `seed:check` verifies the entries against. A matrix the index page does not list, a download the mirror does not hold and a download whose request failed on every attempt are left without that fact and named, so the script can be run again. */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { canonicalJson } from "../../src/serialise";
import { HTTP_STATUS } from "../sources/http-status";
import { systemClock } from "../sources/pacing";
import { DEFAULT_POLITENESS, PoliteClient, RequestFailure } from "../sources/polite-client";
import { SuiteSparseMirrorSchema, suiteSparsePaths } from "./mirror";
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
const mirror = SuiteSparseMirrorSchema.parse(JSON.parse(readFileSync(join(sourcesDir, "suitesparse-mirror.json"), "utf8")));
const held = new Set(mirror.holds);

const client = new PoliteClient(fetch, systemClock, { ...DEFAULT_POLITENESS, timeoutMilliseconds: INDEX_TIMEOUT_MILLISECONDS });
const page = await client.request(INDEX_URL);
if (page.status !== HTTP_STATUS.ok) {
  throw new Error(`${INDEX_URL} answered ${String(page.status)}`);
}
const kinds = parseIndexKinds(await page.text());

const sizes = new Map<string, number>();
const unmeasured: string[] = [];
/**
 * Requests a download's headers.
 * @param url - The download's URL.
 * @returns The response, or the failure when the connection failed on every attempt.
 */
async function head(url: string): Promise<Response | RequestFailure> {
  try {
    return await client.request(url, { method: "HEAD" });
  } catch (error) {
    if (error instanceof RequestFailure) {
      return error;
    }
    throw error;
  }
}

/**
 * Requests the remaining downloads one after another, the client pacing them.
 * @param remaining - The paths not yet requested.
 */
async function measure(remaining: readonly string[]): Promise<void> {
  const [path, ...rest] = remaining;
  if (path === undefined) {
    return;
  }
  const response = await head(`${mirror.host}${path}`);
  if (response instanceof RequestFailure) {
    unmeasured.push(`${path} ${response.message}`);
  } else {
    const length = Number(response.headers.get("content-length"));
    if (response.status === HTTP_STATUS.ok && Number.isInteger(length) && length > 0) {
      sizes.set(path, length);
    } else {
      unmeasured.push(`${path} ${String(response.status)}`);
    }
  }

  return measure(rest);
}
const wanted = suiteSparsePaths(catalogue);
await measure(wanted.filter((path) => held.has(path)));

const matrices: Record<string, { kind: string; downloadBytes?: number }> = {};
const unlisted: string[] = [];
for (const path of wanted) {
  const key = matrixKey(path);
  const kind = key === undefined ? undefined : kinds.get(key);
  if (key === undefined || kind === undefined) {
    unlisted.push(path);
    continue;
  }
  const downloadBytes = sizes.get(path);
  matrices[key] = { kind, ...(downloadBytes === undefined ? {} : { downloadBytes }) };
}

const today = new Date(systemClock.now()).toISOString().slice(0, ISO_DATE_LENGTH);
writeFileSync(join(sourcesDir, "suitesparse-index.json"), canonicalJson(SuiteSparseIndexSchema.parse({ readOn: today, matrices })));
console.log(`${String(Object.keys(matrices).length)} of ${String(wanted.length)} matrices have a kind and ${String(sizes.size)} have a download size.\nNot listed on the index page:\n${unlisted.join("\n")}\nSize not read:\n${unmeasured.join("\n")}`);
