/* The liveness check's decisions, apart from its files: what a probe of a source means, which sources are findings, and what the report and the tracking issue say. The check never edits an entry. */

import { z } from "zod";
import { canonicalJson } from "../../src/serialise";
import type { SourceGroup } from "./entries";
import { HTTP_STATUS, isClientError, isRefusal, isSuccess } from "./http-status";
import type { PoliteClient } from "./polite-client";
import { isDefinitiveFailure, type Probe, probe, redirectsToMissingPage, statusEvidence } from "./probe";

/** What a probe of a source means for the catalogue: `ok` it answers; `gone` the host says it does not exist (404, 410, another client error, or a name that no longer resolves); `blocked` the host refuses this client (401, 403), which says nothing about whether a visitor can reach it; `unreachable` the host failed to answer properly on every attempt (a busy or failing host, a timeout). */
export const SOURCE_STATES = ["ok", "gone", "blocked", "unreachable"] as const;
export type SourceState = (typeof SOURCE_STATES)[number];

/** One source URL's result: what the catalogue records about it, what the probe found and the length the host stated. */
export const SourceResultSchema = z
  .object({
    url: z.url(),
    entries: z.array(z.string().min(1)).min(1),
    recorded: z.enum(["live", "dead"]),
    state: z.enum(SOURCE_STATES),
    evidence: z.string().min(1),
    contentLength: z.int().min(0).optional(),
  })
  .strict();
export type SourceResult = z.infer<typeof SourceResultSchema>;

const ReportSchema = z.object({ sources: z.array(SourceResultSchema) }).strict();

/**
 * The meaning of one probe.
 * @param url - The URL that was probed.
 * @param looked - What the probe found.
 * @returns The state, and the observation it rests on.
 */
export function classifyProbe(url: string, looked: Probe): { state: SourceState; evidence: string } {
  if (looked.kind === "unreachable") {
    const evidence = looked.code ?? "no answer";

    return { state: isDefinitiveFailure(looked.code) ? "gone" : "unreachable", evidence };
  }
  const { status } = looked;
  const evidence = statusEvidence(status, url, looked.finalUrl);
  if (isSuccess(status)) {
    return redirectsToMissingPage(url, looked.finalUrl) ? { state: "gone", evidence: `redirects to ${looked.finalUrl}` } : { state: "ok", evidence };
  }
  if (isRefusal(status)) {
    return { state: "blocked", evidence };
  }
  if (isClientError(status) && status !== HTTP_STATUS.tooManyRequests) {
    return { state: "gone", evidence };
  }

  return { state: "unreachable", evidence };
}

/**
 * Orders URLs so consecutive ones are on different hosts where they can be: one URL from each host in turn, then the next of each. A pool of workers taking URLs in this order spreads over the hosts instead of queueing behind the one that has most of the catalogue.
 * @param urls - The URLs.
 * @returns The same URLs, interleaved by host, each host's own order kept.
 */
export function interleaveByHost(urls: readonly string[]): string[] {
  const queues = new Map<string, string[]>();
  for (const url of urls) {
    const { host } = new URL(url);
    queues.set(host, [...(queues.get(host) ?? []), url]);
  }
  const ordered: string[] = [];
  for (let round = 0; ordered.length < urls.length; round++) {
    for (const queue of queues.values()) {
      const next = queue[round];
      if (next !== undefined) {
        ordered.push(next);
      }
    }
  }

  return ordered;
}

/**
 * Probes every source URL of the catalogue.
 * @param client - The polite client, which paces per host.
 * @param groups - The catalogue's source groups.
 * @param concurrency - How many URLs are in flight at once.
 * @returns One result per URL, sorted by URL.
 */
export async function checkSources(client: PoliteClient, groups: readonly SourceGroup[], concurrency: number): Promise<SourceResult[]> {
  const byUrl = new Map(groups.map((group) => [group.url, group]));
  const queue = interleaveByHost(groups.map((group) => group.url));
  const results: SourceResult[] = [];
  const worker = async (): Promise<void> => {
    const url = queue.shift();
    if (url === undefined) {
      return;
    }
    const group = byUrl.get(url);
    if (group === undefined) {
      throw new Error(`${url} was queued without a group`);
    }
    const looked = await probe(client, url);
    results.push({
      url,
      entries: [...group.entryIds],
      recorded: group.live ? "live" : "dead",
      ...classifyProbe(url, looked),
      ...(looked.kind === "answered" && looked.contentLength !== undefined && isSuccess(looked.status) ? { contentLength: looked.contentLength } : {}),
    });

    return worker();
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  return results.sort((left, right) => (left.url < right.url ? -1 : 1));
}

/**
 * The report file's text.
 * @param results - The results.
 * @returns The file text, in the committed JSON form.
 */
export function checkReportText(results: readonly SourceResult[]): string {
  return canonicalJson({ sources: results });
}

/**
 * Parses a report written by an earlier check, for its content lengths.
 * @param text - The report file's text.
 * @returns The results.
 * @throws The schema's error when the text is not a report.
 */
export function parseCheckReport(text: string): SourceResult[] {
  return ReportSchema.parse(JSON.parse(text)).sources;
}

/** A source whose stated length differs from the one an earlier check recorded. */
export interface LengthChange {
  readonly result: SourceResult;
  readonly was: number;
  readonly now: number;
}

/** What the check found that the catalogue does not yet reflect. */
export interface Findings {
  /** Recorded `live` but no longer resolving (`gone` or `unreachable`). */
  readonly lost: readonly SourceResult[];
  /** Recorded `dead` but answering again. */
  readonly revived: readonly SourceResult[];
  /** Answering, with a different length than the earlier check recorded. */
  readonly changed: readonly LengthChange[];
  /** Recorded `live` and refusing this client; not a finding on its own, listed for a person to look at. */
  readonly blocked: readonly SourceResult[];
}

/**
 * Sorts the results into what needs a person's attention.
 * @param results - This check's results.
 * @param baseline - The earlier check's results, when there is one.
 * @returns The findings.
 */
export function findingsOf(results: readonly SourceResult[], baseline: readonly SourceResult[]): Findings {
  const earlier = new Map(baseline.map((result) => [result.url, result]));
  const changed: LengthChange[] = [];
  for (const result of results) {
    const was = earlier.get(result.url)?.contentLength;
    if (result.state === "ok" && result.contentLength !== undefined && was !== undefined && was !== result.contentLength) {
      changed.push({ result, was, now: result.contentLength });
    }
  }

  return {
    lost: results.filter((result) => result.recorded === "live" && (result.state === "gone" || result.state === "unreachable")),
    revived: results.filter((result) => result.recorded === "dead" && result.state === "ok"),
    changed,
    blocked: results.filter((result) => result.recorded === "live" && result.state === "blocked"),
  };
}

/**
 * Whether the findings call for a tracking issue: a source lost, revived or changed in length. A source that merely refuses this client does not.
 * @param findings - The findings.
 * @returns True when there is something to track.
 */
export function needsIssue(findings: Findings): boolean {
  return findings.lost.length > 0 || findings.revived.length > 0 || findings.changed.length > 0;
}

const list = (results: readonly SourceResult[], describe: (result: SourceResult) => string): string[] => results.map((result) => `- ${result.url} (${result.entries.join(", ")}): ${describe(result)}`);

/**
 * The tracking issue's body. Entries are not edited by the check: a source recorded `live` that is gone is marked `dead` with its pinned snapshot in a reviewed change.
 * @param findings - The findings.
 * @returns Markdown.
 */
export function issueBody(findings: Findings): string {
  const sections: string[] = ["The scheduled source check found sources whose live state no longer matches what the catalogue records. It edits no entry. Mark a gone source `dead` and pin its snapshot (`scripts/archive-sources.ts` finds or requests one) in a reviewed change."];
  if (findings.lost.length > 0) {
    sections.push(["Recorded live, no longer resolving:", ...list(findings.lost, (result) => `${result.state}, ${result.evidence}`)].join("\n"));
  }
  if (findings.revived.length > 0) {
    sections.push(["Recorded dead, answering again:", ...list(findings.revived, (result) => result.evidence)].join("\n"));
  }
  if (findings.changed.length > 0) {
    sections.push(["Stated length changed since the last check:", ...findings.changed.map(({ result, was, now }) => `- ${result.url} (${result.entries.join(", ")}): ${String(was)} bytes, now ${String(now)}`)].join("\n"));
  }
  if (findings.blocked.length > 0) {
    sections.push(["Refusing this client, which does not show they are gone:", ...list(findings.blocked, (result) => result.evidence)].join("\n"));
  }

  return `${sections.join("\n\n")}\n`;
}
