/* Requests every source URL the catalogue records and reports the ones that no longer resolve.

   pnpm run sources:check [--entries-dir <dir>] [--report <file>] [--baseline <file>] [--issue-body <file>] [--concurrency <n>]

   Each distinct URL is looked at once (HEAD, falling back to a request for the first byte), paced per host with backoff when a host is busy. The result for every URL goes to the report (default reports/source-check.json, untracked) in a deterministic form. --baseline names an earlier report: a source whose stated length differs from the one recorded there is a finding. The tracking issue's body is written to --issue-body only when there is a finding to track, and a body left by an earlier run is removed otherwise, so the workflow decides whether to open, update or close the issue from the file's existence. No entry is ever edited: marking a source dead and pinning its snapshot is a reviewed change. */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { checkReportText, checkSources, findingsOf, issueBody, needsIssue, parseCheckReport } from "./sources/check";
import { groupSources, loadEntryFiles } from "./sources/entries";
import { systemClock } from "./sources/pacing";
import { DEFAULT_POLITENESS, PoliteClient } from "./sources/polite-client";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** How many URLs are probed at once. Pacing is per host, so this only bounds how many hosts are being waited on or answered together; a few dozen sockets at a time is far below what a CI runner or a single visitor's browser holds open. */
const DEFAULT_CONCURRENCY = 16;

const { values } = parseArgs({
  options: {
    "entries-dir": { type: "string", default: join(repoRoot, "catalogue/entries") },
    report: { type: "string", default: join(repoRoot, "reports/source-check.json") },
    baseline: { type: "string" },
    "issue-body": { type: "string", default: join(repoRoot, "reports/source-check.md") },
    concurrency: { type: "string", default: String(DEFAULT_CONCURRENCY) },
  },
  strict: true,
});

const concurrency = Number(values.concurrency);
if (!Number.isInteger(concurrency) || concurrency < 1) {
  throw new Error("--concurrency takes a whole number of at least 1");
}
// Read before the report is written: the baseline may be the report's own path.
const baseline = values.baseline !== undefined && existsSync(values.baseline) ? parseCheckReport(readFileSync(values.baseline, "utf8")) : [];

const groups = groupSources(loadEntryFiles(values["entries-dir"]));
const results = await checkSources(new PoliteClient(fetch, systemClock, DEFAULT_POLITENESS), groups, concurrency);

mkdirSync(dirname(values.report), { recursive: true });
writeFileSync(values.report, checkReportText(results), "utf8");
const findings = findingsOf(results, baseline);
mkdirSync(dirname(values["issue-body"]), { recursive: true });
if (needsIssue(findings)) {
  writeFileSync(values["issue-body"], issueBody(findings), "utf8");
  console.log(`Findings written to ${values["issue-body"]}.`);
} else {
  rmSync(values["issue-body"], { force: true });
  console.log("Every recorded source matches the catalogue.");
}
