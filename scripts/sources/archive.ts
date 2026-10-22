/* The archiver's decisions, apart from its files and its network: for each source URL, pin the snapshot the Wayback Machine already holds, or ask it for a capture, or record why the URL cannot be archived. Everything outside reaches it through ports, so a unit test drives the whole policy with stand-ins. */

import { z } from "zod";
import { WaybackTimestampSchema } from "../../src/entry";
import type { ArchiveException, ExceptionReason, Report } from "./archive-report";
import type { SourceGroup } from "./entries";
import { HTTP_STATUS, isRefusal, isSuccess } from "./http-status";
import { type Clock, intervalForRate, Pacer } from "./pacing";
import { type PoliteClient, RequestFailure } from "./polite-client";
import { isDefinitiveFailure, probe, redirectsToMissingPage, statusEvidence } from "./probe";
import { type FailureReason, VERIFY_ATTEMPTS, verifyPin } from "./verify";
import { ARCHIVE_SIZE_LIMIT_BYTES, findSnapshot, type SaveOutcome, WaybackBusy } from "./wayback";

/** How many times a capture is requested for one URL in a run, and how long the wait before the second request is (each later wait doubles it). A busy service clears in a minute or two, and every request counts against the day's limit, so the tries are few and the first wait is long. */
export const SAVE_ATTEMPTS = 3;
export const SAVE_BACKOFF_MILLISECONDS = 30_000;

/** How many URLs in a row may end unresolved because of the Wayback Machine before the run stops. A service or network that fails five URLs in a row is down or has throttled this client, and going on only adds requests; the run is resumable, so stopping loses nothing. */
export const MAX_CONSECUTIVE_UNRESOLVED = 5;

/** How many captures of one URL may be taken and not served back, as the Wayback Machine's 404 or its own page, before the URL is recorded as one it cannot serve. One such capture may be indexing lag, which the verification's waits cover; a second, taken later, is the host's answer. */
export const UNSERVED_CAPTURES_BEFORE_EXCEPTION = 2;

/** What the archiver keeps between runs in its gitignored state file: the UTC day and how many captures were requested on it, so the account's daily limit holds across restarts, and the captures of each URL that failed verification, so the availability API handing the same bad capture back is not trusted again. A state file written before the rejections were kept has none, and nothing was rejected then. `deferred` counts the runs in a row each URL ended unresolved, so a URL that cannot be settled goes behind the ones that can and never holds up the queue. */
export const ArchiveStateSchema = z
  .object({ day: z.string(), captures: z.int().min(0), rejected: z.record(z.string(), z.array(WaybackTimestampSchema)).default({}), deferred: z.record(z.string(), z.int().min(1)).default({}) })
  .strict();
export type ArchiveState = z.infer<typeof ArchiveStateSchema>;

/** The way captures are requested: its documented limits, and one request for a capture. */
export interface Saver {
  readonly limits: { readonly capturesPerMinute: number; readonly capturesPerDay: number };
  readonly save: (url: string) => Promise<SaveOutcome>;
}

/** Everything the archiver touches outside itself. */
export interface ArchivePorts {
  /** Probes sources and asks the capture index. */
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
  /** How many URLs are settled at once. The shared pacing (the capture rate and each host's interval) is what bounds the requests, so this only lets one URL's waits (a capture's indexing, a verification backoff) overlap the next URLs' work. */
  readonly concurrency: number;
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
  | { readonly kind: "unresolved"; readonly evidence: string; readonly service: boolean }
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
  // A URL that ended unresolved in earlier runs is tried after those that did not, so a few that cannot be settled do not stop the run before it reaches the rest; the sort is stable, so URLs with the same count keep the catalogue's order.
  const queue = [...request.groups].sort((left, right) => (state.deferred[left.url] ?? 0) - (state.deferred[right.url] ?? 0));
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
   * Requests a capture's raw snapshot before it is pinned. A capture that fails is remembered as rejected, so the capture index offering it again is not trusted a second time.
   * @param group - The URL and what the catalogue records about it.
   * @param timestamp - The capture's timestamp.
   * @param attempts - How many lookups at most; more for a capture just made, whose indexing lags.
   * @param followed - Whether this timestamp is the capture another's replay answered from, which is followed once and no further.
   * @returns pinned when the raw snapshot serves the captured bytes, unresolved when the archive could not say, failed with what was observed when it does not serve them.
   */
  const check = async (group: SourceGroup, timestamp: string, attempts: number, followed = false): Promise<Resolution | { kind: "failed"; evidence: string; reason: FailureReason }> => {
    const verdict = await verifyPin({ client, clock }, { url: group.url, timestamp, live: group.live, compareStrictly: true }, attempts);
    if (verdict.kind === "verified") {
      return { kind: "pinned", timestamp };
    }
    if (verdict.kind === "busy") {
      return { kind: "unresolved", service: true, evidence: `the capture ${timestamp} could not be verified (${verdict.evidence})` };
    }
    state.rejected[group.url] = [...(state.rejected[group.url] ?? []), timestamp];
    persist(structuredClone(state));
    // A capture whose replay answers from an earlier capture is no capture of its own (the Wayback Machine stores an unchanged file once), but the capture it answers from is one: it is checked on its own, so the pin names bytes that exist.
    if (verdict.reason === "other-capture" && verdict.landed !== undefined && !followed && state.rejected[group.url]?.includes(verdict.landed) !== true) {
      log(`${group.url}: the capture ${timestamp} answers from ${verdict.landed}; checking that one`);

      return check(group, verdict.landed, 1, true);
    }

    return { kind: "failed", evidence: verdict.evidence, reason: verdict.reason };
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
        return { kind: "unresolved", service: true, evidence: outcome.evidence };
      }
      await clock.sleep(SAVE_BACKOFF_MILLISECONDS * 2 ** (attempt - 1));

      return capture(group, attempt + 1);
    }
    if (outcome.kind === "url-limited") {
      return { kind: "unresolved", service: false, evidence: `the URL has been captured as often as a day allows (${outcome.evidence})` };
    }
    if (outcome.kind === "limit") {
      return { kind: "stop", why: "the day's capture limit is spent" };
    }
    if (outcome.kind === "saved") {
      const checked = await check(group, outcome.timestamp, VERIFY_ATTEMPTS);

      if (checked.kind === "failed" && (checked.reason === "not-served" || checked.reason === "wayback-page") && (state.rejected[url]?.length ?? 0) >= UNSERVED_CAPTURES_BEFORE_EXCEPTION) {
        return { kind: "excepted", reason: "not-served", evidence: `${String(state.rejected[url]?.length)} captures were taken and the Wayback Machine served none of them back: ${checked.evidence}` };
      }

      return checked.kind === "failed" ? { kind: "unresolved", service: false, evidence: `the capture ${outcome.timestamp} was not accepted: ${checked.evidence}` } : checked;
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
        return { kind: "unresolved", service: true, evidence: error.message };
      }
      throw error;
    }
    const looked = await probe(client, group.url);
    if (looked.kind === "unreachable") {
      return isDefinitiveFailure(looked.code) ? { kind: "excepted", reason: "source-error", evidence: looked.code ?? "unreachable" } : { kind: "unresolved", service: false, evidence: looked.code ?? "unreachable" };
    }
    if (!isSuccess(looked.status)) {
      const refusal = classifyStatus(looked.status, statusEvidence(looked.status, group.url, looked.finalUrl));

      return refusal === undefined ? { kind: "unresolved", service: false, evidence: `HTTP ${String(looked.status)}` } : { kind: "excepted", ...refusal };
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
   * Forgets that a URL was ever left unresolved, once it is settled.
   * @param url - The URL.
   */
  const clearDeferred = (url: string): void => {
    if (state.deferred[url] !== undefined) {
      state.deferred = Object.fromEntries(Object.entries(state.deferred).filter(([key]) => key !== url));
      persist(structuredClone(state));
    }
  };

  /**
   * Applies a resolution to the run's records.
   * @param group - The URL's group.
   * @param resolution - What it came to.
   */
  const settle = (group: SourceGroup, resolution: Resolution): void => {
    switch (resolution.kind) {
      case "pinned":
        clearDeferred(group.url);
        record(group.url, resolution.timestamp);
        verified(group.url, resolution.timestamp);
        pinned.add(group.url);
        consecutive = 0;
        log(`${group.url}: pinned ${resolution.timestamp}`);
        break;
      case "excepted":
        clearDeferred(group.url);
        excepted.set(group.url, { reason: resolution.reason, evidence: resolution.evidence });
        except({ url: group.url, entries: [...group.entryIds], reason: resolution.reason, evidence: resolution.evidence });
        consecutive = 0;
        log(`${group.url}: cannot be archived (${resolution.reason}: ${resolution.evidence})`);
        break;
      case "unresolved":
        state.deferred[group.url] = (state.deferred[group.url] ?? 0) + 1;
        persist(structuredClone(state));
        unresolved.push(group.url);
        // Only trouble with the Wayback Machine counts towards stopping: a URL whose own host fails, or whose capture is not served back, says nothing about the next URL, and the deferral already sends it behind the others.
        consecutive += resolution.service ? 1 : 0;
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

  /** The next group no worker has taken, which a worker claims before it first waits, so no two workers take the same one. */
  let cursor = 0;

  /**
   * One worker: takes the next group, settles it, and goes on until the groups or the run's bounds are used up.
   */
  const work = async (): Promise<void> => {
    const group = queue[cursor];
    cursor += 1;
    if (group === undefined || stopped !== undefined) {
      return;
    }
    const inScope = request.entryIds === undefined || group.entryIds.some((id) => request.entryIds?.has(id) === true);
    if (!inScope) {
      return work();
    }
    if (group.snapshot !== undefined) {
      if (group.unpinned) {
        record(group.url, group.snapshot.timestamp);
        log(`${group.url}: pinned on the entries that lacked it (${group.snapshot.timestamp})`);
      }

      return work();
    }
    if (known.has(group.url) && !request.retryExceptions) {
      return work();
    }
    if (request.limit !== undefined && resolved >= request.limit) {
      stopped = "the limit on URLs for this run is reached";

      return;
    }
    resolved += 1;
    settle(group, await resolve(group));

    return work();
  };
  await Promise.all(Array.from({ length: request.concurrency }, async () => work()));

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
