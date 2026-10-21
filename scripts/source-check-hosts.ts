/* Splits the catalogue's source hosts into the buckets the weekly check runs as a matrix, so each job owns a share of the hosts and keeps its own per-host pacing. Prints the matrix as the JSON a workflow's fromJson consumes: one object per bucket, its name and its hosts.

   pnpm exec tsx scripts/source-check-hosts.ts [--entries-dir <dir>] [--buckets <n>] */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { groupSources, loadEntryFiles } from "./sources/entries";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** How many parallel jobs the weekly check splits into: each bucket keeps a runner to itself for a fraction of the serial run's duration, and four hosted runners stay far inside the account's concurrent quota. */
const DEFAULT_BUCKETS = 4;

const { values } = parseArgs({
  options: {
    "entries-dir": { type: "string", default: join(repoRoot, "catalogue/entries") },
    buckets: { type: "string", default: String(DEFAULT_BUCKETS) },
  },
  strict: true,
});

const buckets = Number(values.buckets);
if (!Number.isInteger(buckets) || buckets < 1) {
  throw new Error("--buckets takes a whole number of at least 1");
}

const hosts = [...new Set(groupSources(loadEntryFiles(values["entries-dir"])).map((group) => new URL(group.url).host))].sort();
const matrix = Array.from({ length: buckets }, (_, bucket) => ({
  name: `bucket-${String(bucket + 1)}`,
  hosts: hosts.filter((_host, at) => at % buckets === bucket),
}));
console.log(JSON.stringify(matrix.filter((bucket) => bucket.hosts.length > 0)));
