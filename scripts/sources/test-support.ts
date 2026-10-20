/* Stand-ins the source scripts' unit tests share: a clock that advances only when something sleeps, a scripted network, and a quick way to make an entry with sources. */

import { type Entry, parseEntry } from "../../src/entry";
import { liveEntry } from "../../src/test-support/entries";
import type { Clock } from "./pacing";
import { type FetchPort, type Politeness } from "./polite-client";

/** Where a fake clock starts when a test does not say: an arbitrary instant well after the epoch. */
const DEFAULT_START = 1_000_000;

/** A second in milliseconds, for tests that state intervals. */
export const SECOND = 1000;

/** A minute in milliseconds. */
export const MINUTE = 60_000;

/** How long a scripted request may take before the client gives up on it. */
const TEST_TIMEOUT = 5000;

/**
 * The element of an array at an index, which a test expects to exist.
 * @param items - The array.
 * @param index - The index.
 * @returns The element.
 * @throws Error when the array is shorter, which fails the test with the missing index named.
 */
export function at<Item>(items: readonly Item[], index: number): Item {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`expected an element at index ${String(index)} of ${String(items.length)}`);
  }

  return item;
}

/** A clock whose time moves only by sleeping, with every sleep recorded. */
export class FakeClock implements Clock {
  readonly sleeps: number[] = [];

  private instant: number;

  constructor(start = DEFAULT_START) {
    this.instant = start;
  }

  readonly now = (): number => this.instant;

  readonly sleep = async (milliseconds: number): Promise<void> => {
    this.sleeps.push(milliseconds);
    this.instant += milliseconds;
    // Yields as a real sleep does, so concurrent callers interleave as they would in production.
    await Promise.resolve();
  };
}

/** One request a scripted network saw. */
export interface SeenRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string | undefined;
}

/** What a scripted network does with a request: answers, or fails as the platform `fetch` does when the connection fails. */
export type Script = (request: SeenRequest) => Response | Error;

/**
 * A network that answers each request from a script and records what it was asked.
 * @param script - Decides each answer.
 * @returns The port and the requests seen so far.
 */
export function scriptedNetwork(script: Script): { fetch: FetchPort; seen: SeenRequest[] } {
  const seen: SeenRequest[] = [];

  return {
    seen,
    fetch: async (url, init) => {
      const request: SeenRequest = { url, method: init.method ?? "GET", headers: new Headers(init.headers), body: typeof init.body === "string" ? init.body : undefined };
      seen.push(request);
      const answer = script(request);
      await Promise.resolve();
      if (answer instanceof Error) {
        throw answer;
      }

      return answer;
    },
  };
}

/** The failure the platform `fetch` throws for a connection that fails: a TypeError whose cause carries the code. */
export function connectionError(code: string): Error {
  const cause = new Error(code);
  Object.defineProperty(cause, "code", { value: code });

  return new TypeError("fetch failed", { cause });
}

/** Pacing and retries small enough that a test sees every effect without waiting: one attempt count, round intervals. */
export const TEST_POLITENESS: Politeness = { hostIntervalMilliseconds: SECOND, globalIntervalMilliseconds: 10, attempts: 3, backoffMilliseconds: 2 * SECOND, timeoutMilliseconds: TEST_TIMEOUT };

/**
 * A parsed entry with the given sources, built on the shared live entry.
 * @param id - The entry id.
 * @param sources - The entry's sources.
 * @param extra - Further fields that replace the base entry's.
 * @returns The entry.
 */
export function entryWith(id: string, sources: readonly unknown[], extra: Record<string, unknown> = {}): Entry {
  return parseEntry({ ...liveEntry, id, name: id, sources, ...extra });
}

/** A live source of a URL, as an entry records it. */
export function liveSource(url: string): { url: string; retrieved: string; status: "live" } {
  return { url, retrieved: "2026-10-01", status: "live" };
}

/**
 * A response that says it came from another URL, as one does after redirects.
 * @param finalUrl - Where the answer came from.
 * @param init - The response's status and headers.
 * @returns The response.
 */
export function answerFrom(finalUrl: string, init: ResponseInit): Response {
  const response = new Response(null, init);
  Object.defineProperty(response, "url", { value: finalUrl });

  return response;
}
