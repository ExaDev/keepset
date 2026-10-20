/* Pins a Wayback Machine snapshot on every source of every catalogue entry, and reports the sources that cannot be archived.

   pnpm exec tsx scripts/archive-sources.ts [--check] [--entry <id>]... [--limit <urls>] [--retry-exceptions] [--entries-dir <dir>] [--report <file>] [--state <file>]

   For each distinct source URL with no snapshot it asks the Wayback Machine's availability API for an existing capture, and requests a new one with Save Page Now only when there is none. The snapshot is recorded on the source in the entry file as `{ timestamp, url }` with `url` exactly `waybackUrl(timestamp, url)`; entry files are read in canonical form and written with `serialise`, so nothing but the snapshot of a source changes. A URL that cannot be archived goes in scripts/archive-sources.report.json with the reason (see EXCEPTION_REASONS) and what was observed. A failure that says nothing about the URL (a busy service, a timeout) leaves it unresolved, to be tried by the next run: the entry files and the report are written as each URL settles, so a run can be stopped and started again at any point, on any machine.

   Save Page Now is used with the Internet Archive S3-style key pair when IA_ACCESS_KEY and IA_SECRET_KEY are both set (7 captures a minute, 30 000 a day), and anonymously otherwise (3 a minute, 200 a day, the documented limits). Both limits are kept, the day's count in the state file (default reports/archive-state.json, untracked).

   --check changes nothing and exits non-zero when a source has no snapshot and the report does not account for it, or when the report lists a source the catalogue no longer supports. --entry limits the run to the named entries, --limit to a number of URLs resolved over the network, --retry-exceptions looks again at URLs the report already excepts. --entries-dir, --report and --state point the run somewhere else, for a trial on a copy. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { canonicalJson } from "../src/serialise";
import { type ArchiveState, ArchiveStateSchema, archiveProblems, archiveSources, type Saver } from "./sources/archive";
import { type ArchiveException, readReport, reportText } from "./sources/archive-report";
import { groupSources, loadEntryFiles, recordSnapshots } from "./sources/entries";
import { systemClock } from "./sources/pacing";
import { DEFAULT_POLITENESS, PoliteClient } from "./sources/polite-client";
import { ANONYMOUS_LIMITS, AUTHENTICATED_LIMITS, MAX_CAPTURE_WAIT_MILLISECONDS, saveAnonymously, saveAuthenticated } from "./sources/wayback";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const { values } = parseArgs({
  options: {
    check: { type: "boolean" },
    entry: { type: "string", multiple: true },
    limit: { type: "string" },
    "retry-exceptions": { type: "boolean" },
    "entries-dir": { type: "string", default: join(repoRoot, "catalogue/entries") },
    report: { type: "string", default: join(repoRoot, "scripts/archive-sources.report.json") },
    state: { type: "string", default: join(repoRoot, "reports/archive-state.json") },
  },
  strict: true,
});

let files = loadEntryFiles(values["entries-dir"]);
const exceptions = readReport(values.report);

if (values.check === true) {
  const problems = archiveProblems(groupSources(files), exceptions);
  if (problems.length > 0) {
    throw new Error(`the archive is incomplete:\n${problems.join("\n")}`);
  }
  console.log("Every source is pinned to a snapshot or accounted for in the report.");
} else {
  const limit = values.limit === undefined ? undefined : Number(values.limit);
  if (limit !== undefined && !Number.isInteger(limit)) {
    throw new Error("--limit takes a whole number of URLs");
  }
  const { IA_ACCESS_KEY: accessKey, IA_SECRET_KEY: secretKey } = process.env;
  if ((accessKey === undefined || accessKey === "") !== (secretKey === undefined || secretKey === "")) {
    throw new Error("IA_ACCESS_KEY and IA_SECRET_KEY must be set together, or neither");
  }
  const credentials = accessKey === undefined || accessKey === "" || secretKey === undefined ? undefined : { accessKey, secretKey };

  const probing = new PoliteClient(fetch, systemClock, DEFAULT_POLITENESS);
  // A capture is never retried by the client: every request is one against the day's limit, and the archiver paces and retries them itself.
  const capturing = new PoliteClient(fetch, systemClock, { ...DEFAULT_POLITENESS, attempts: 1, timeoutMilliseconds: MAX_CAPTURE_WAIT_MILLISECONDS });
  const saver: Saver =
    credentials === undefined
      ? { limits: ANONYMOUS_LIMITS, save: async (url) => saveAnonymously(capturing, url) }
      : { limits: AUTHENTICATED_LIMITS, save: async (url) => saveAuthenticated(capturing, systemClock, credentials, url) };

  const state: ArchiveState = existsSync(values.state) ? ArchiveStateSchema.parse(JSON.parse(readFileSync(values.state, "utf8"))) : { day: "", captures: 0 };
  const settled = new Map<string, ArchiveException>(exceptions.map((exception) => [exception.url, exception]));
  const writeReport = (): void => {
    writeFileSync(values.report, reportText([...settled.values()]), "utf8");
  };

  const result = await archiveSources(
    {
      client: probing,
      saver,
      clock: systemClock,
      record: (url, timestamp) => {
        files = recordSnapshots(files, new Map([[url, timestamp]])).files;
        settled.delete(url);
        writeReport();
      },
      except: (exception) => {
        settled.set(exception.url, exception);
        writeReport();
      },
      persist: (next) => {
        mkdirSync(dirname(values.state), { recursive: true });
        writeFileSync(values.state, canonicalJson(next), "utf8");
      },
      log: (line) => {
        console.log(line);
      },
    },
    { groups: groupSources(files), exceptions, retryExceptions: values["retry-exceptions"] === true, entryIds: values.entry === undefined ? undefined : new Set(values.entry), limit, state },
  );
  writeFileSync(values.report, reportText(result.exceptions), "utf8");
  console.log(`${credentials === undefined ? "Anonymous" : "Authenticated"} run finished; report ${relative(repoRoot, values.report)}; ${String(result.unresolved.length)} URLs left unresolved${result.stopped === undefined ? "" : `; stopped early: ${result.stopped}`}.`);
  for (const url of result.unresolved) {
    console.log(`unresolved: ${url}`);
  }
}
