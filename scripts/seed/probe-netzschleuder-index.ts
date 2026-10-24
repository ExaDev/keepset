/* Records the tags Netzschleuder states for each network the pipeline catalogue links to there.

   pnpm exec tsx scripts/seed/probe-netzschleuder-index.ts [--pipeline <catalog.json>]

   --pipeline defaults to the committed copy in scripts/seed/sources/. Each network's record is requested from the API (`https://networks.skewed.de/api/net/<name>`) through the polite client, paced per host, and its tags are written to scripts/seed/sources/netzschleuder-index.json, which the import reads and `seed:check` verifies the entries against. A network the API does not answer for, or that it gives no tags, is left out and named. */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { canonicalJson } from "../../src/serialise";
import { HTTP_STATUS } from "../sources/http-status";
import { systemClock } from "../sources/pacing";
import { DEFAULT_POLITENESS, PoliteClient } from "../sources/polite-client";
import { networkName, NetzschleuderIndexSchema } from "./netzschleuder-index";
import { downloadsOf, SourceCatalogueSchema } from "./source";

/** The length of the `YYYY-MM-DD` prefix of an ISO 8601 timestamp. */
const ISO_DATE_LENGTH = "YYYY-MM-DD".length;
const API = "https://networks.skewed.de/api/net/";
const RecordSchema = z.looseObject({ tags: z.array(z.string().min(1)) });
const sourcesDir = join(dirname(fileURLToPath(import.meta.url)), "sources");
const { values } = parseArgs({ options: { pipeline: { type: "string" } }, strict: true });
const catalogue = SourceCatalogueSchema.parse(JSON.parse(readFileSync(values.pipeline ?? join(sourcesDir, "pipeline-catalog.json"), "utf8")));

const wanted = [...new Set(Object.values(catalogue.datasets).flatMap((dataset) => downloadsOf(dataset.sources ?? []).flatMap(({ url }) => (url === undefined ? [] : (networkName(url) ?? [])))))].sort();
const client = new PoliteClient(fetch, systemClock, DEFAULT_POLITENESS);
const networks: Record<string, string[]> = {};
const missing: string[] = [];
/**
 * Requests the remaining networks one after another, the client pacing them.
 * @param remaining - The names not yet requested.
 */
async function probe(remaining: readonly string[]): Promise<void> {
  const [name, ...rest] = remaining;
  if (name === undefined) {
    return;
  }
  const response = await client.request(`${API}${name}`);
  const parsed = response.status === HTTP_STATUS.ok ? RecordSchema.safeParse(await response.json()) : undefined;
  if (parsed?.success === true && parsed.data.tags.length > 0) {
    networks[name] = parsed.data.tags;
  } else {
    missing.push(`${name} ${String(response.status)}`);
  }

  return probe(rest);
}
await probe(wanted);

const today = new Date(systemClock.now()).toISOString().slice(0, ISO_DATE_LENGTH);
writeFileSync(join(sourcesDir, "netzschleuder-index.json"), canonicalJson(NetzschleuderIndexSchema.parse({ readOn: today, networks })));
console.log(`${String(Object.keys(networks).length)} of ${String(wanted.length)} networks have tags; not answered:\n${missing.join("\n")}`);
