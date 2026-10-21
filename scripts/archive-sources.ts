/* Pins a Wayback Machine snapshot on every source of every catalogue entry, and reports the sources that cannot be archived.

   pnpm exec tsx scripts/archive-sources.ts [--check | --verify [--reverify]] [--entry <id>]... [--limit <urls>] [--retry-exceptions] [--entries-dir <dir>] [--report <file>] [--state <file>]

   For each distinct source URL with no snapshot it asks the Wayback Machine's availability API for an existing capture, and requests a new one with Save Page Now only when there is none. A capture, found or new, is pinned only after its raw `id_` form has been requested and answered with the captured bytes (see scripts/sources/verify.ts); one that does not is rejected, remembered in the state file so the availability API offering it again is not trusted, and a new capture is requested in its place. The snapshot is recorded on the source in the entry file as `{ timestamp, url }` with `url` exactly `waybackUrl(timestamp, url)`; entry files are read in canonical form and written with `serialise`, so nothing but the snapshot of a source changes. A URL that cannot be archived goes in scripts/archive-sources.report.json with the reason (see EXCEPTION_REASONS) and what was observed. A failure that says nothing about the URL (a busy service, a timeout) leaves it unresolved, to be tried by the next run: the entry files and the report are written as each URL settles, so a run can be stopped and started again at any point, on any machine.

   Save Page Now is used with the Internet Archive S3-style key pair when IA_ACCESS_KEY and IA_SECRET_KEY are both set (7 captures a minute, 30 000 a day), and anonymously otherwise (3 a minute, 200 a day, the documented limits). Both limits are kept, the day's count in the state file (default reports/archive-state.json, untracked).

   --verify requests the raw snapshot of every pin already recorded that the report does not list as verified, lists the ones that serve their bytes in the report, and removes the ones that do not from the live sources that hold them, so the next run captures them again; a failing pin on a dead source stays (the entry schema requires it, and the source cannot be captured again) and makes the run exit non-zero. --reverify requests the pins the report lists as verified again.

   --check changes nothing and exits non-zero when a source has no snapshot and the report does not account for it, when a pin is not listed as verified in the report, or when the report lists a source or a verification the catalogue no longer supports. --entry limits the run to the named entries, --limit to a number of URLs (or, with --verify, pins) requested over the network, --retry-exceptions looks again at URLs the report already excepts. --entries-dir, --report and --state point the run somewhere else, for a trial on a copy. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { canonicalJson } from "../src/serialise";
import { type ArchiveState, ArchiveStateSchema, archiveProblems, archiveSources, type Saver } from "./sources/archive";
import { type ArchiveException, readReport, reportText, type VerifiedPin } from "./sources/archive-report";
import { groupSources, loadEntryFiles, recordSnapshots, removeSnapshot } from "./sources/entries";
import { systemClock } from "./sources/pacing";
import { DEFAULT_POLITENESS, PoliteClient } from "./sources/polite-client";
import { pinKey, verifyPins } from "./sources/verify-pins";
import { ANONYMOUS_LIMITS, AUTHENTICATED_LIMITS, MAX_CAPTURE_WAIT_MILLISECONDS, saveAnonymously, saveAuthenticated } from "./sources/wayback";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const { values } = parseArgs({
  options: {
    check: { type: "boolean" },
    verify: { type: "boolean" },
    reverify: { type: "boolean" },
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
const report = readReport(values.report);

if (values.check === true) {
  const problems = archiveProblems(groupSources(files), report);
  if (problems.length > 0) {
    throw new Error(`the archive is incomplete:\n${problems.join("\n")}`);
  }
  console.log("Every source is pinned to a verified snapshot or accounted for in the report.");
} else {
  const limit = values.limit === undefined ? undefined : Number(values.limit);
  if (limit !== undefined && !Number.isInteger(limit)) {
    throw new Error("--limit takes a whole number of URLs");
  }
  if (values.reverify === true && values.verify !== true) {
    throw new Error("--reverify goes with --verify");
  }
  const { IA_ACCESS_KEY: accessKey, IA_SECRET_KEY: secretKey } = process.env;
  if ((accessKey === undefined || accessKey === "") !== (secretKey === undefined || secretKey === "")) {
    throw new Error("IA_ACCESS_KEY and IA_SECRET_KEY must be set together, or neither");
  }
  const credentials = accessKey === undefined || accessKey === "" || secretKey === undefined ? undefined : { accessKey, secretKey };

  const probing = new PoliteClient(fetch, systemClock, DEFAULT_POLITENESS);
  const state: ArchiveState = existsSync(values.state) ? ArchiveStateSchema.parse(JSON.parse(readFileSync(values.state, "utf8"))) : ArchiveStateSchema.parse({ day: "", captures: 0 });
  const settled = new Map<string, ArchiveException>(report.exceptions.map((exception) => [exception.url, exception]));
  const verifiedPins = new Map<string, VerifiedPin>(report.verified.map((pin) => [pinKey(pin.url, pin.timestamp), pin]));
  const writeReport = (): void => {
    writeFileSync(values.report, reportText({ exceptions: [...settled.values()], verified: [...verifiedPins.values()] }), "utf8");
  };
  const persist = (next: Readonly<ArchiveState>): void => {
    mkdirSync(dirname(values.state), { recursive: true });
    writeFileSync(values.state, canonicalJson(next), "utf8");
  };
  const verified = (url: string, timestamp: string): void => {
    verifiedPins.set(pinKey(url, timestamp), { url, timestamp });
    writeReport();
  };
  const entryIds = values.entry === undefined ? undefined : new Set(values.entry);

  if (values.verify === true) {
    const result = await verifyPins(
      {
        client: probing,
        clock: systemClock,
        unpin: (url, timestamp) => {
          files = removeSnapshot(files, url, timestamp);
        },
        verified,
        unverified: (url, timestamp) => {
          verifiedPins.delete(pinKey(url, timestamp));
          writeReport();
        },
        persist,
        log: (line) => {
          console.log(line);
        },
      },
      { groups: groupSources(files), alreadyVerified: new Set(verifiedPins.keys()), reverify: values.reverify === true, entryIds, limit, state },
    );
    console.log(`Verification finished; ${String(result.removed.length)} pins removed to be captured again, ${String(result.kept.length)} failing pins kept on dead sources, ${String(result.unresolved.length)} could not be checked${result.stopped === undefined ? "" : `; stopped early: ${result.stopped}`}.`);
    for (const failure of result.kept) {
      console.log(`needs another snapshot: ${failure.url} at ${failure.timestamp} (${failure.evidence})`);
    }
    if (result.kept.length > 0) {
      throw new Error("a dead source pins a snapshot that does not serve its bytes");
    }
  } else {
    // A capture is never retried by the client: every request is one against the day's limit, and the archiver paces and retries them itself.
    const capturing = new PoliteClient(fetch, systemClock, { ...DEFAULT_POLITENESS, attempts: 1, timeoutMilliseconds: MAX_CAPTURE_WAIT_MILLISECONDS });
    const saver: Saver =
      credentials === undefined
        ? { limits: ANONYMOUS_LIMITS, save: async (url) => saveAnonymously(capturing, url) }
        : { limits: AUTHENTICATED_LIMITS, save: async (url) => saveAuthenticated(capturing, systemClock, credentials, url) };

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
        verified,
        except: (exception) => {
          settled.set(exception.url, exception);
          writeReport();
        },
        persist,
        log: (line) => {
          console.log(line);
        },
      },
      { groups: groupSources(files), exceptions: report.exceptions, retryExceptions: values["retry-exceptions"] === true, entryIds, limit, state },
    );
    writeFileSync(values.report, reportText({ exceptions: result.exceptions, verified: [...verifiedPins.values()] }), "utf8");
    console.log(`${credentials === undefined ? "Anonymous" : "Authenticated"} run finished; report ${relative(repoRoot, values.report)}; ${String(result.unresolved.length)} URLs left unresolved${result.stopped === undefined ? "" : `; stopped early: ${result.stopped}`}.`);
    for (const url of result.unresolved) {
      console.log(`unresolved: ${url}`);
    }
  }
}
