/* The seed import: converts the thesis pipeline's graph dataset catalogue into keepset entries, giving graph/v1 its seed corpus.

   pnpm run seed:import --pipeline <catalog.json> --graphbox <catalog.json> [--snapshot] [--check]

   --pipeline names the pipeline catalogue (a checkout's experiments/pipeline/graphs/catalog.json, or the committed copy in scripts/seed/sources/) and --graphbox the graphbox catalogue, read only for the report's overlap section. Both are read and never written: every path this script writes is inside this repository, and it refuses to run when an input directory contains the repository, so no output can land in a source checkout.

   It writes catalogue/entries/<id>.json for every dataset that converts and the report beside this script. An entry the previous report recorded as converted but this run does not produce is deleted, so a re-import of a later catalogue version is a plain diff; entries the import never wrote are left alone.

   --snapshot also refreshes the committed source copies in scripts/seed/sources/, with every file: URL's path withheld: a local path names a machine, not a public source, and the import drops such downloads whatever their path, so the copy converts to the same entries as the original.

   --check writes nothing and exits non-zero when the committed entries or report differ from what the inputs produce. */

import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { canonicalJson, serialise } from "../../src/serialise";
import { convertCatalogue } from "./convert";
import { GraphboxCatalogueSchema, SourceCatalogueSchema } from "./source";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = realpathSync(join(here, "../.."));
const entriesDir = join(repoRoot, "catalogue/entries");
const reportPath = join(here, "phd-graph-catalogue.report.json");
const sourcesDir = join(here, "sources");

const { values } = parseArgs({
  options: {
    pipeline: { type: "string" },
    graphbox: { type: "string" },
    snapshot: { type: "boolean" },
    check: { type: "boolean" },
  },
  strict: true,
});
if (values.pipeline === undefined || values.graphbox === undefined) {
  throw new Error("usage: import-phd-catalogue --pipeline <catalog.json> --graphbox <catalog.json> [--snapshot] [--check]");
}

/**
 * Resolves an input path, refusing one whose directory contains this repository.
 * @param path - The input file.
 * @returns Its real path.
 */
function inputPath(path: string): string {
  const real = realpathSync(path);
  const dir = dirname(real);
  if (repoRoot === dir || repoRoot.startsWith(`${dir}${sep}`)) {
    throw new Error(`${path} sits in a directory that contains this repository; the import reads its sources from outside the tree it writes`);
  }

  return real;
}

const pipelinePath = inputPath(values.pipeline);
const graphboxPath = inputPath(values.graphbox);
const pipelineText = readFileSync(pipelinePath, "utf8");
const graphboxText = readFileSync(graphboxPath, "utf8");
const pipeline = SourceCatalogueSchema.parse(JSON.parse(pipelineText));
const graphbox = GraphboxCatalogueSchema.parse(JSON.parse(graphboxText));
const { entries, report } = convertCatalogue(pipeline, graphbox);

/**
 * The entry ids a report records as converted.
 * @param text - A report file's text.
 * @returns The ids.
 */
function convertedIds(text: string): Set<string> {
  const doc: unknown = JSON.parse(text);
  if (typeof doc !== "object" || doc === null || !("outcomes" in doc) || !Array.isArray(doc.outcomes)) {
    throw new Error(`${relative(repoRoot, reportPath)} has no outcomes list`);
  }
  const ids = new Set<string>();
  const outcomes: readonly unknown[] = doc.outcomes;
  for (const outcome of outcomes) {
    if (typeof outcome === "object" && outcome !== null && "id" in outcome && typeof outcome.id === "string" && "outcome" in outcome && outcome.outcome !== "not-converted") {
      ids.add(outcome.id);
    }
  }

  return ids;
}

const writes = new Map<string, string>(entries.map((entry) => [join(entriesDir, `${entry.id}.json`), serialise(entry)]));
writes.set(reportPath, canonicalJson(report));
if (values.snapshot === true) {
  const withheld = (text: string): string => `${JSON.stringify(JSON.parse(text, (_key, value: unknown) => (typeof value === "string" && value.startsWith("file:") ? "file:(local path withheld)" : value)), undefined, 2)}\n`;
  writes.set(join(sourcesDir, "pipeline-catalog.json"), withheld(pipelineText));
  writes.set(join(sourcesDir, "graphbox-catalog.json"), withheld(graphboxText));
}
const produced = new Set(entries.map((entry) => entry.id));
const stale = existsSync(reportPath) ? [...convertedIds(readFileSync(reportPath, "utf8"))].filter((id) => !produced.has(id)).map((id) => join(entriesDir, `${id}.json`)) : [];

if (values.check === true) {
  const differing = [...writes].filter(([path, text]) => !existsSync(path) || readFileSync(path, "utf8") !== text).map(([path]) => relative(repoRoot, path));
  const lingering = stale.filter((path) => existsSync(path)).map((path) => relative(repoRoot, path));
  if (differing.length > 0 || lingering.length > 0) {
    throw new Error(`the committed import output differs from what the inputs produce: ${[...differing, ...lingering.map((path) => `${path} (stale)`)].join(", ")}`);
  }
  console.log(`The committed import output matches: ${String(entries.length)} entries and the report.`);
} else {
  for (const [path, text] of writes) {
    writeFileSync(path, text, "utf8");
  }
  for (const path of stale) {
    rmSync(path, { force: true });
  }
  const counts = new Map<string, number>();
  for (const outcome of report.outcomes) {
    counts.set(outcome.outcome, (counts.get(outcome.outcome) ?? 0) + 1);
  }
  console.log(`Wrote ${String(entries.length)} entries and ${relative(repoRoot, reportPath)} (${[...counts].map(([outcome, count]) => `${outcome} ${String(count)}`).join(", ")}); removed ${String(stale.length)} stale entries.`);
}
