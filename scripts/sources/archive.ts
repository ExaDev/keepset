/* The archiver's decisions, apart from its files and its network: for each source URL, pin the snapshot the Wayback Machine already holds, or ask it for a capture, or record why the URL cannot be archived. Everything outside reaches it through ports, so a unit test drives the whole policy with stand-ins. */

import { z } from "zod";
import { WaybackTimestampSchema } from "../../src/entry";
import type { ArchiveException, ExceptionReason, Report } from "./archive-report";
import type { SourceGroup } from "./entries";
import { HTTP_STATUS, isRefusal, isSuccess } from "./http-status";
import { type Clock, intervalForRate, Pacer } from "./pacing";
import { type PoliteClient, RequestFailure } from "./polite-client";
import { isDefinitiveFailure, probe, redirectsToMissingPage, statusEvidence } from "./probe";
import { VERIFY_ATTEMPTS, verifyPin } from "./verify";
import { ARCHIVE_SIZE_LIMIT_BYTES, findSnapshot, type SaveOutcome, WaybackBusy } from "./wayback";

/** How many times a capture is requested for one URL in a run, and how long the wait before the second request is (each later wait doubles it). A busy service clears in a minute or two, and every request counts against the day's limit, so the tries are few and the first wait is long. */
export const SAVE_ATTEMPTS = 3;
export const SAVE_BACKOFF_MILLISECONDS = 30_000;

/** How many URLs in a row may end unresolved before the run stops. A service or network that fails five URLs in a row is down or has throttled this client, and going on only adds requests; the run is resumable, so stopping loses nothing. */
export const MAX_CONSECUTIVE_UNRESOLVED = 5;

/** What the archiver keeps between runs in its gitignored state file: the UTC day and how many captures were requested on it, so the account's daily limit holds across restarts, and the captures of each URL that failed verification, so the availability API handing the same bad capture back is not trusted again. A state file written before the rejections were kept has none, and nothing was rejected then. */
export const ArchiveStateSchema = z
  .object({ day: z.string(), captures: z.int().min(0), rejected: z.record(z.string(), z.array(WaybackTimestampSchema)).default({}) })
  .strict();
export type ArchiveState = z.infer<typeof ArchiveStateSchema>;

/** The way captures are requested: its documented limits, and one request for a capture. */
export interface Saver {
  readonly limits: { readonly capturesPerMinute: number; readonly capturesPerDay: number };
  readonly save: (url: string) => Promise<SaveOutcome>;
}

/** Everything the archiver touches outside itself. */
export interface ArchivePorts {
  /** Probes sources and asks the availability API. */
  readonly client: PoliteClient;
  readonly saver: Saver;
  readonly clock: Clock;
  /** Pins a timestamp on every source with that URL, durably, before the archiver goes on. */
  readonly record: (url: string, timestamp: string) => void;
  /** Records durably that the pin of that URL at that timestamp served its bytes. */
  readonly verified: (url: string, timestamp: string) => void;
  /** Stores an exception durably, replacing any earlier one for the same URL, so a run cut short keeps what it settled. */
  readonly except: (exception: ArchiveException) => void;
  /** Stores the state durably. */
  readonly persist: (state: Readonly<ArchiveState>) => void;
  readonly log: (line: string) => void;
}

/** What one run is asked to do. */
export interface ArchiveRequest {
  readonly groups: readonly SourceGroup[];
  /** The exceptions the committed report holds. */
  readonly exceptions: readonly ArchiveException[];
  /** Whether to look again at URLs the report already excepts. */
  readonly retryExceptions: boolean;
  /** The entries to work on; every entry when undefined. */
  readonly entryIds: ReadonlySet<string> | undefined;
  /** The most URLs to resolve over the network in this run; no bound when undefined. */
  readonly limit: number | undefined;
  readonly state: ArchiveState;
}

/** What a run came to: the exceptions the report should now hold, the URLs it could not settle, and why it stopped early when it did. */
export interface ArchiveResult {
  readonly exceptions: ArchiveException[];
  readonly unresolved: string[];
  readonly stopped: string | undefined;
}

type Resolution =
  | { readonly kind: "pinned"; readonly timestamp: string }
  | { readonly kind: "excepted"; readonly reason: ExceptionReason; readonly evidence: string }
  | { readonly kind: "unresolved"; readonly evidence: string }
  | { readonly kind: "stop"; readonly why: string };

/**
 * Sorts a refused probe into the exception it stands for, or into a failure that says nothing about the source.
 * @param status - The final HTTP status.
 * @param evidence - What to record as the observation; the status by default.
 * @returns The exception's reason and evidence, or undefined for a status that is only the host's passing trouble (429).
 */
export function classifyStatus(status: number, evidence = `HTTP ${String(status)}`): { reason: ExceptionReason; evidence: string } | undefined {
  if (status === HTTP_STATUS.tooManyRequests) {
    return undefined;
  }

  return { reason: isRefusal(status) ? "access-wall" : "source-error", evidence };
}

/** The length of an ISO date, `YYYY-MM-DD`, at the start of an ISO timestamp. */
const ISO_DATE_LENGTH = 10;

/** The UTC day of an instant, `YYYY-MM-DD`: the day the Internet Archive counts a capture against. */
function utcDay(instant: number): string {
  return new Date(instant).toISOString().slice(0, ISO_DATE_LENGTH);
}

/**
 * Resolves the sources of a catalogue: for each URL not yet settled, the existing snapshot, a new capture, or the reason there can be neither.
 * @param ports - What the archiver touches outside itself.
 * @param request - The catalogue's source groups, the report so far and the run's bounds.
 * @returns The exceptions the report should hold, the unresolved URLs and why the run stopped, if it did.
 * @throws WaybackError when the Wayback Machine answers in a way the archiver does not understand, or rejects its credentials.
 */
export async function archiveSources(ports: Readonly<ArchivePorts>, request: Readonly<ArchiveRequest>): Promise<ArchiveResult> {
  const { client, saver, clock, record, verified, except, persist, log } = ports;
  const state: ArchiveState = structuredClone(request.state);
  const capturePacer = new Pacer(clock);
  const captureInterval = intervalForRate(saver.limits.capturesPerMinute);
  const known = new Map(request.exceptions.map((exception) => [exception.url, exception]));
  const excepted = new Map<string, Pick<ArchiveException, "reason" | "evidence">>();
  const pinned = new Set<string>();
  const unresolved: string[] = [];
  let resolved = 0;
  let consecutive = 0;
  let stopped: string | undefined;

  /**
   * One request for a capture, within the account's limits.
   * @param url - The URL.
   * @returns What the request came to; `retry` when it failed for reasons that say nothing about the URL.
   */
  const requestCapture = async (url: string): Promise<SaveOutcome | { kind: "limit" }> => {
    const today = utcDay(clock.now());
    if (state.day !== today) {
      state.day = today;
      state.captures = 0;
    }
    if (state.captures >= saver.limits.capturesPerDay) {
      return { kind: "limit" };
    }
    await capturePacer.wait("capture", captureInterval);
    state.captures += 1;
    persist({ ...state });
    try {
      return await saver.save(url);
    } catch (error) {
      if (error instanceof RequestFailure) {
        return { kind: "retry", evidence: error.code ?? error.message };
      }
      throw error;
    }
  };

  /**
   * Requests a capture's raw snapshot before it is pinned. A capture that fails is remembered as rejected, so the availability API offering it again is not trusted a second time.
   * @param group - The URL and what the catalogue records about it.
   * @param timestamp - The capture's timestamp.
   * @param attempts - How many lookups at most; more for a capture just made, whose indexing lags.
   * @returns pinned when the raw snapshot serves the captured bytes, unresolved when the archive could not say, failed with what was observed when it does not serve them.
   */
  const check = async (group: SourceGroup, timestamp: string, attempts: number): Promise<Resolution | { kind: "failed"; evidence: string }> => {
    const verdict = await verifyPin({ client, clock }, { url: group.url, timestamp, live: group.live, compareStrictly: true }, attempts);
    if (verdict.kind === "verified") {
      return { kind: "pinned", timestamp };
    }
    if (verdict.kind === "busy") {
      return { kind: "unresolved", evidence: `the capture ${timestamp} could not be verified (${verdict.evidence})` };
    }
    state.rejected[group.url] = [...(state.rejected[group.url] ?? []), timestamp];
    persist(structuredClone(state));

    return { kind: "failed", evidence: verdict.evidence };
  };

  /**
   * Requests a capture, and again after a failure that says nothing about the URL, waiting longer each time.
   * @param group - The URL and what the catalogue records about it.
   * @param attempt - Which request this is, from 1.
   * @returns What the capture came to; pinned only once its raw snapshot served the captured bytes.
   */
  const capture = async (group: SourceGroup, attempt: number): Promise<Resolution> => {
    const { url } = group;
    const outcome = await requestCapture(url);
    if (outcome.kind === "retry") {
      if (attempt >= SAVE_ATTEMPTS) {
        return { kind: "unresolved", evidence: outcome.evidence };
      }
      await clock.sleep(SAVE_BACKOFF_MILLISECONDS * 2 ** (attempt - 1));

      return capture(group, attempt + 1);
    }
    if (outcome.kind === "limit") {
      return { kind: "stop", why: "the day's capture limit is spent" };
    }
    if (outcome.kind === "saved") {
      const checked = await check(group, outcome.timestamp, VERIFY_ATTEMPTS);

      return checked.kind === "failed" ? { kind: "unresolved", evidence: `the capture ${outcome.timestamp} was not accepted: ${checked.evidence}` } : checked;
    }
    if (outcome.kind === "refused") {
      return { kind: "excepted", reason: outcome.reason, evidence: outcome.evidence };
    }

    return { kind: "stop", why: `Save Page Now refused further captures (${outcome.evidence})` };
  };

  /**
   * Settles one URL that has no snapshot: finds one, or explains why not, or asks for a capture.
   * @param group - The URL and what the catalogue records about it.
   * @returns The resolution.
   */
  const resolve = async (group: SourceGroup): Promise<Resolution> => {
    if (group.paged) {
      return { kind: "excepted", reason: "paged-api", evidence: "a recipe reads this URL as a paged query, so a capture of the URL is not the data" };
    }
    try {
      const existing = await findSnapshot(client, group.url);
      if (existing !== undefined && state.rejected[group.url]?.includes(existing) === true) {
        log(`${group.url}: the capture ${existing} failed verification before; requesting a new one`);
      } else if (existing !== undefined) {
        const checked = await check(group, existing, 1);
        if (checked.kind !== "failed") {
          return checked;
        }
        log(`${group.url}: the existing capture ${existing} was not accepted (${checked.evidence}); requesting a new one`);
      }
    } catch (error) {
      if (error instanceof WaybackBusy) {
        return { kind: "unresolved", evidence: error.message };
      }
      throw error;
    }
    const looked = await probe(client, group.url);
    if (looked.kind === "unreachable") {
      return isDefinitiveFailure(looked.code) ? { kind: "excepted", reason: "source-error", evidence: looked.code ?? "unreachable" } : { kind: "unresolved", evidence: looked.code ?? "unreachable" };
    }
    if (!isSuccess(looked.status)) {
      const refusal = classifyStatus(looked.status, statusEvidence(looked.status, group.url, looked.finalUrl));

      return refusal === undefined ? { kind: "unresolved", evidence: `HTTP ${String(looked.status)}` } : { kind: "excepted", ...refusal };
    }
    if (redirectsToMissingPage(group.url, looked.finalUrl)) {
      return { kind: "excepted", reason: "source-error", evidence: `redirects to ${looked.finalUrl}` };
    }
    if (looked.contentLength !== undefined && looked.contentLength > ARCHIVE_SIZE_LIMIT_BYTES) {
      return { kind: "excepted", reason: "size-limit", evidence: `Content-Length ${String(looked.contentLength)}` };
    }

    return capture(group, 1);
  };

  /**
   * Applies a resolution to the run's records.
   * @param group - The URL's group.
   * @param resolution - What it came to.
   */
  const settle = (group: SourceGroup, resolution: Resolution): void => {
    switch (resolution.kind) {
      case "pinned":
        record(group.url, resolution.timestamp);
        verified(group.url, resolution.timestamp);
        pinned.add(group.url);
        consecutive = 0;
        log(`${group.url}: pinned ${resolution.timestamp}`);
        break;
      case "excepted":
        excepted.set(group.url, { reason: resolution.reason, evidence: resolution.evidence });
        except({ url: group.url, entries: [...group.entryIds], reason: resolution.reason, evidence: resolution.evidence });
        consecutive = 0;
        log(`${group.url}: cannot be archived (${resolution.reason}: ${resolution.evidence})`);
        break;
      case "unresolved":
        unresolved.push(group.url);
        consecutive += 1;
        log(`${group.url}: left unresolved (${resolution.evidence})`);
        break;
      case "stop":
        unresolved.push(group.url);
        stopped = resolution.why;
        break;
    }
    if (stopped === undefined && consecutive >= MAX_CONSECUTIVE_UNRESOLVED) {
      stopped = "too many URLs in a row could not be settled";
    }
  };

  /**
   * Works through the groups from an index on, one at a time: the account's limits and the host pacing are shared, so the URLs are settled in order.
   * @param index - The group to work on.
   */
  const work = async (index: number): Promise<void> => {
    const group = request.groups[index];
    if (group === undefined || stopped !== undefined) {
      return;
    }
    const inScope = request.entryIds === undefined || group.entryIds.some((id) => request.entryIds?.has(id) === true);
    if (!inScope) {
      return work(index + 1);
    }
    if (group.snapshot !== undefined) {
      if (group.unpinned) {
        record(group.url, group.snapshot.timestamp);
        log(`${group.url}: pinned on the entries that lacked it (${group.snapshot.timestamp})`);
      }

      return work(index + 1);
    }
    if (known.has(group.url) && !request.retryExceptions) {
      return work(index + 1);
    }
    if (request.limit !== undefined && resolved >= request.limit) {
      stopped = "the limit on URLs for this run is reached";

      return;
    }
    resolved += 1;
    settle(group, await resolve(group));

    return work(index + 1);
  };
  await work(0);

  const exceptions: ArchiveException[] = [];
  for (const group of request.groups) {
    const current = excepted.get(group.url) ?? known.get(group.url);
    if (current !== undefined && group.snapshot === undefined && !pinned.has(group.url)) {
      exceptions.push({ url: group.url, entries: [...group.entryIds], reason: current.reason, evidence: current.evidence });
    }
  }

  return { exceptions, unresolved, stopped };
}

/**
 * What is wrong with the archive's state against the catalogue: a source without a snapshot that the report does not account for, a pin the report does not record as verified, and a report line the catalogue no longer supports.
 * @param groups - The catalogue's source groups.
 * @param report - The committed report: the exceptions and the verified pins.
 * @returns One line per problem; empty when every source is pinned with a verified snapshot or excepted, and every exception and every verification is current.
 */
export function archiveProblems(groups: readonly SourceGroup[], report: Readonly<Report>): string[] {
  const { exceptions } = report;
  const byUrl = new Map(exceptions.map((exception) => [exception.url, exception]));
  const verifiedPins = new Set(report.verified.map((pin) => `${pin.url}\n${pin.timestamp}`));
  const problems: string[] = [];
  for (const group of groups) {
    const exception = byUrl.get(group.url);
    if (exception === undefined) {
      if (group.unpinned) {
        problems.push(`${group.url} has no snapshot and the report does not say why (entries: ${group.entryIds.join(", ")})`);
      }
    } else if (group.snapshot !== undefined) {
      problems.push(`${group.url} is listed as ${exception.reason} but an entry pins a snapshot of it`);
    } else if (exception.entries.join("\n") !== group.entryIds.join("\n")) {
      problems.push(`${group.url} is listed for different entries than list it now`);
    }
  }
  const urls = new Set(groups.map((group) => group.url));
  for (const exception of exceptions) {
    if (!urls.has(exception.url)) {
      problems.push(`${exception.url} is in the report but no entry has it as a source`);
    }
  }
  for (const group of groups) {
    for (const pin of group.pins) {
      if (!verifiedPins.has(`${group.url}\n${pin.timestamp}`)) {
        problems.push(`${group.url} pins the snapshot ${pin.timestamp}, which has not been verified (run with --verify)`);
      }
    }
  }
  const pinned = new Set(groups.flatMap((group) => group.pins.map((pin) => `${group.url}\n${pin.timestamp}`)));
  for (const pin of report.verified) {
    if (!pinned.has(`${pin.url}\n${pin.timestamp}`)) {
      problems.push(`${pin.url} is recorded as verified at ${pin.timestamp}, which no entry pins`);
    }
  }

  return problems;
}
