import { describe, expect, it } from "vitest";
import { type ArchiveState, MAX_CONSECUTIVE_UNRESOLVED } from "./archive";
import { HTTP_STATUS } from "./http-status";
import { groupSources, snapshotOf } from "./entries";
import { PoliteClient } from "./polite-client";
import { connectionError, entryWith, FakeClock, liveSource, scriptedNetwork, TEST_POLITENESS } from "./test-support";
import { pinKey, verifyPins, type VerifyPorts, type VerifyRequest } from "./verify-pins";

const U = "https://x.example/file.csv";
const OTHER = "https://y.example/page";
const TS = "20261021014848";
const RAW = `https://web.archive.org/web/${TS}id_/${U}`;

/** What the pass came to, recorded through its ports as a run would. */
interface Trial {
  readonly result: ReturnType<typeof verifyPins>;
  readonly unpinned: string[];
  readonly verified: string[];
  readonly unverified: string[];
  readonly states: ArchiveState[];
  readonly log: string[];
}

/**
 * Runs the pass over a scripted network.
 * @param pins - The pins to judge: a URL, a timestamp, and whether a dead source holds it.
 * @param answers - What each raw snapshot URL answers: a status, or `"unreachable"`.
 * @param overrides - Further request fields.
 * @returns The trial.
 */
function trial(pins: readonly { url: string; timestamp: string; dead: boolean }[], answers: Readonly<Record<string, number | "unreachable">>, overrides: Partial<VerifyRequest> = {}): Trial {
  const clock = new FakeClock();
  const unpinned: string[] = [];
  const verified: string[] = [];
  const unverified: string[] = [];
  const states: ArchiveState[] = [];
  const log: string[] = [];
  const sources = pins.map((pin) => (pin.dead ? { url: pin.url, retrieved: "2026-10-01", status: "dead" as const, snapshot: snapshotOf(pin.timestamp, pin.url) } : { ...liveSource(pin.url), snapshot: snapshotOf(pin.timestamp, pin.url) }));
  const network = scriptedNetwork((request) => {
    const answer = answers[request.url];
    if (answer === "unreachable") {
      return connectionError("ECONNREFUSED");
    }
    if (request.url.startsWith("https://web.archive.org/web/")) {
      if (answer === undefined) {
        const response = new Response("a,b\n1,2\n", { status: HTTP_STATUS.partialContent, headers: { "memento-datetime": "Wed, 21 Oct 2026 01:48:48 GMT", "content-type": "text/csv" } });
        Object.defineProperty(response, "url", { value: request.url });

        return response;
      }

      return new Response(null, { status: answer, headers: { "content-type": "text/html" } });
    }

    return new Response("a,b\n1,2\n", { status: 200, headers: { "content-type": "text/csv" } });
  });
  const ports: VerifyPorts = {
    client: new PoliteClient(network.fetch, clock, { ...TEST_POLITENESS, attempts: 1 }),
    clock,
    unpin: (url, timestamp) => {
      unpinned.push(`${url}@${timestamp}`);
    },
    verified: (url, timestamp) => {
      verified.push(`${url}@${timestamp}`);
    },
    unverified: (url, timestamp) => {
      unverified.push(`${url}@${timestamp}`);
    },
    persist: (state) => {
      states.push(state);
    },
    log: (line) => {
      log.push(line);
    },
  };
  const entries = sources.map((source, index) => ({ path: String(index), entry: entryWith(`e${String(index)}`, [source]) }));
  const request: VerifyRequest = { groups: groupSources(entries), alreadyVerified: new Set<string>(), reverify: false, entryIds: undefined, limit: undefined, state: { day: "", captures: 0, rejected: {}, deferred: {} }, ...overrides };

  return { result: verifyPins(ports, request), unpinned, verified, unverified, states, log };
}

/** The evidence a raw snapshot that answers the Wayback Machine's 404 page carries. */
const pageNotFound = "the raw snapshot answered HTTP 404 with the Wayback Machine's page";

describe("verifyPins", () => {
  it("records a pin whose raw snapshot serves its bytes and leaves the entries alone", async () => {
    const pass = trial([{ url: U, timestamp: TS, dead: false }], {});
    const outcome = await pass.result;
    expect(outcome).toMatchObject({ removed: [], kept: [], unresolved: [], stopped: undefined });
    expect(pass.verified).toEqual([`${U}@${TS}`]);
    expect(pass.unpinned).toEqual([]);
  });

  it("removes a failing pin from a live source and remembers the capture as rejected, so the next archiving run does not trust it", async () => {
    const pass = trial([{ url: U, timestamp: TS, dead: false }], { [RAW]: HTTP_STATUS.notFound });
    const outcome = await pass.result;
    expect(outcome.removed).toEqual([{ url: U, timestamp: TS, evidence: "the raw snapshot answered HTTP 404 with the Wayback Machine's page" }]);
    expect(pass.unpinned).toEqual([`${U}@${TS}`]);
    expect(pass.unverified).toEqual([`${U}@${TS}`]);
    expect(pass.states.at(-1)?.rejected[U]).toEqual([TS]);
  });

  it("keeps a failing pin a dead source holds, and says it needs another snapshot", async () => {
    const pass = trial([{ url: U, timestamp: TS, dead: true }], { [RAW]: HTTP_STATUS.notFound });
    const outcome = await pass.result;
    expect(outcome.kept).toEqual([{ url: U, timestamp: TS, evidence: pageNotFound }]);
    expect(pass.unpinned).toEqual([]);
    expect(pass.log.at(0)).toContain("a dead source holds it");
  });

  it("skips the pins the report already records as verified, unless asked again", async () => {
    const skipped = trial([{ url: U, timestamp: TS, dead: false }], {}, { alreadyVerified: new Set([pinKey(U, TS)]) });
    await skipped.result;
    expect(skipped.verified).toEqual([]);
    const again = trial([{ url: U, timestamp: TS, dead: false }], {}, { alreadyVerified: new Set([pinKey(U, TS)]), reverify: true });
    await again.result;
    expect(again.verified).toEqual([`${U}@${TS}`]);
  });

  it("stops asking when the archive will not answer", async () => {
    const pins = Array.from({ length: MAX_CONSECUTIVE_UNRESOLVED + 1 }, (_, index) => ({ url: `https://z${String(index)}.example/f`, timestamp: TS, dead: false }));
    const answers = Object.fromEntries(pins.map((pin) => [`https://web.archive.org/web/${TS}id_/${pin.url}`, "unreachable" as const]));
    const pass = trial(pins, answers);
    const outcome = await pass.result;
    expect(outcome.stopped).toMatch(/in a row/);
    expect(outcome.unresolved).toHaveLength(MAX_CONSECUTIVE_UNRESOLVED);
  });

  it("bounds the pins requested and works only on the named entries", async () => {
    const bounded = trial(
      [
        { url: U, timestamp: TS, dead: false },
        { url: OTHER, timestamp: TS, dead: false },
      ],
      {},
      { limit: 1 },
    );
    const outcome = await bounded.result;
    expect(bounded.verified).toEqual([`${U}@${TS}`]);
    expect(outcome.stopped).toMatch(/limit/);
    const named = trial([{ url: U, timestamp: TS, dead: false }, { url: OTHER, timestamp: TS, dead: false }], {}, { entryIds: new Set(["e1"]) });
    await named.result;
    expect(named.verified).toEqual([`${OTHER}@${TS}`]);
  });
});
