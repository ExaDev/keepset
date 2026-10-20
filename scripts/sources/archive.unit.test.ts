import { describe, expect, it } from "vitest";
import { HTTP_STATUS } from "./http-status";
import { type ArchiveException } from "./archive-report";
import { archiveProblems, archiveSources, type ArchivePorts, type ArchiveRequest, type ArchiveState, classifyStatus, MAX_CONSECUTIVE_UNRESOLVED, SAVE_ATTEMPTS, SAVE_BACKOFF_MILLISECONDS } from "./archive";
import { groupSources, snapshotOf } from "./entries";
import { intervalForRate } from "./pacing";
import { PoliteClient } from "./polite-client";
import { answerFrom, at, connectionError, entryWith, FakeClock, liveSource, scriptedNetwork, type SeenRequest, TEST_POLITENESS } from "./test-support";
import { ARCHIVE_SIZE_LIMIT_BYTES, type SaveOutcome } from "./wayback";

/** The documented anonymous limits, which a test uses unless it states its own. */
const DEFAULT_PER_MINUTE = 3;
const DEFAULT_PER_DAY = 200;
/** A noon on a fixed UTC day, so the state's day is known. */
const NOON = new Date("2026-10-20T12:00:00Z").getTime();

interface World {
  /** The account's captures a day, when a test needs a smaller one. */
  readonly perDay?: number;
  /** What the availability API says per URL: a timestamp, or none. */
  readonly available?: Readonly<Record<string, string>>;
  /** What the host answers per URL for HEAD and GET: a status and a length. */
  readonly hosts?: Readonly<Record<string, { status: number; length?: number; finalUrl?: string } | "unreachable">>;
  /** What each capture request comes to, in order. */
  readonly saves?: readonly SaveOutcome[];
}

function run(urls: readonly string[], world: World, overrides: Partial<ArchiveRequest> = {}): { result: ReturnType<typeof archiveSources>; recorded: Map<string, string>; excepted: ArchiveException[]; captured: string[]; captureTimes: number[]; clock: FakeClock; states: ArchiveState[]; seen: SeenRequest[] } {
  const clock = new FakeClock(NOON);
  const seen: SeenRequest[] = [];
  const network = scriptedNetwork((request) => {
    seen.push(request);
    if (request.url.startsWith("https://archive.org/wayback/available")) {
      const url = new URL(request.url).searchParams.get("url") ?? "";
      const timestamp = world.available?.[url];

      return new Response(JSON.stringify({ archived_snapshots: timestamp === undefined ? {} : { closest: { available: true, status: "200", timestamp } } }), { status: 200 });
    }
    const host = world.hosts?.[request.url] ?? { status: 200 };
    if (host === "unreachable") {
      return connectionError("ENOTFOUND");
    }

    return answerFrom(host.finalUrl ?? "", { status: host.status, headers: host.length === undefined ? {} : { "content-length": String(host.length) } });
  });
  const recorded = new Map<string, string>();
  const excepted: ArchiveException[] = [];
  const captured: string[] = [];
  const captureTimes: number[] = [];
  const states: ArchiveState[] = [];
  const saves = [...(world.saves ?? [])];
  const ports: ArchivePorts = {
    client: new PoliteClient(network.fetch, clock, { ...TEST_POLITENESS, attempts: 1 }),
    saver: {
      limits: { capturesPerMinute: DEFAULT_PER_MINUTE, capturesPerDay: world.perDay ?? DEFAULT_PER_DAY },
      save: async (url) => {
        await Promise.resolve();
        captured.push(url);
        captureTimes.push(clock.now());
        const next = saves.shift();
        if (next === undefined) {
          throw new Error(`unscripted capture of ${url}`);
        }

        return next;
      },
    },
    clock,
    record: (url, timestamp) => {
      recorded.set(url, timestamp);
    },
    except: (exception) => {
      excepted.push(exception);
    },
    persist: (state) => {
      states.push(state);
    },
    log: () => undefined,
  };
  const files = urls.map((url, index) => ({ path: String(index), entry: entryWith(`e${String(index)}`, [liveSource(url)]) }));
  const request: ArchiveRequest = { groups: groupSources(files), exceptions: [], retryExceptions: false, entryIds: undefined, limit: undefined, state: { day: "", captures: 0 }, ...overrides };

  return { result: archiveSources(ports, request), recorded, excepted, captured, captureTimes, clock, states, seen };
}

const A = "https://example.org/a";
const B = "https://example.org/b";

describe("archiveSources", () => {
  it("pins an existing snapshot without probing the source or requesting a capture", async () => {
    const trial = run([A], { available: { [A]: "20250101000000" } });
    expect((await trial.result).unresolved).toEqual([]);
    expect(trial.recorded.get(A)).toBe("20250101000000");
    expect(trial.captured).toEqual([]);
    expect(trial.seen.every((request) => request.url.startsWith("https://archive.org/"))).toBe(true);
  });

  it("requests a capture only when there is no snapshot, and pins the capture's timestamp", async () => {
    const trial = run([A], { saves: [{ kind: "saved", timestamp: "20261020120001" }] });
    await trial.result;
    expect(trial.captured).toEqual([A]);
    expect(trial.recorded.get(A)).toBe("20261020120001");
  });

  it("spreads capture requests by the documented rate and counts them in the state", async () => {
    const trial = run([A, B], { saves: [{ kind: "saved", timestamp: "20261020120001" }, { kind: "saved", timestamp: "20261020120002" }] });
    await trial.result;
    expect(at(trial.captureTimes, 1) - at(trial.captureTimes, 0)).toBeGreaterThanOrEqual(intervalForRate(DEFAULT_PER_MINUTE));
    expect(trial.states.at(-1)).toEqual({ day: "2026-10-20", captures: 2 });
  });

  it("excepts a paged source without any request", async () => {
    const files = [{ path: "p", entry: entryWith("p", [liveSource(A)], { recipe: { status: "fetchable", source: 0, paging: { kind: "openfema", pageSize: 100 }, archive: { kind: "none" }, parser: { format: "csv-table", encoding: "utf-8", delimiter: "comma", skipLines: 0, idColumn: null, numericColumns: [] } } }) }];
    const trial = run([], {}, { groups: groupSources(files) });
    const outcome = await trial.result;
    expect(outcome.exceptions).toMatchObject([{ url: A, reason: "paged-api", entries: ["p"] }]);
    expect(trial.seen).toEqual([]);
  });

  it("excepts a file past the size limit without requesting a capture", async () => {
    const trial = run([A], { hosts: { [A]: { status: 200, length: ARCHIVE_SIZE_LIMIT_BYTES + 1 } } });
    expect((await trial.result).exceptions).toMatchObject([{ url: A, reason: "size-limit", evidence: `Content-Length ${String(ARCHIVE_SIZE_LIMIT_BYTES + 1)}` }]);
    expect(trial.captured).toEqual([]);
  });

  it("attempts a file exactly at the limit", async () => {
    const trial = run([A], { hosts: { [A]: { status: 200, length: ARCHIVE_SIZE_LIMIT_BYTES } }, saves: [{ kind: "saved", timestamp: "20261020120001" }] });
    await trial.result;
    expect(trial.captured).toEqual([A]);
  });

  it("classifies a refusing or failing host from its status and an unresolvable name from its code", async () => {
    const trial = run([A, B, "https://example.org/c"], { hosts: { [A]: { status: 403 }, [B]: { status: 404 }, "https://example.org/c": "unreachable" } });
    const { exceptions } = await trial.result;
    expect(exceptions.map(({ url, reason, evidence }) => [url, reason, evidence])).toEqual([
      [A, "access-wall", "HTTP 403"],
      [B, "source-error", "HTTP 404"],
      ["https://example.org/c", "source-error", "ENOTFOUND"],
    ]);
    expect(trial.captured).toEqual([]);
  });

  it("excepts a source that redirects to the host's missing-page page, without requesting a capture", async () => {
    const trial = run([A], { hosts: { [A]: { status: HTTP_STATUS.ok, finalUrl: "https://example.org/404" } } });
    expect((await trial.result).exceptions).toMatchObject([{ url: A, reason: "source-error", evidence: "redirects to https://example.org/404" }]);
    expect(trial.captured).toEqual([]);
  });

  it("names the host a refusal came from when a redirect led to another one", async () => {
    const trial = run([A], { hosts: { [A]: { status: HTTP_STATUS.forbidden, finalUrl: "http://files.other.example/a" } } });
    expect((await trial.result).exceptions).toMatchObject([{ url: A, reason: "access-wall", evidence: "HTTP 403 from files.other.example" }]);
  });

  it("records a refusal from Save Page Now under its reason", async () => {
    const trial = run([A], { saves: [{ kind: "refused", reason: "excluded", evidence: "error:blocked-url" }] });
    expect((await trial.result).exceptions).toMatchObject([{ url: A, reason: "excluded", evidence: "error:blocked-url" }]);
    expect(trial.excepted).toHaveLength(1);
  });

  it("retries a capture that fails for the service's own reasons, waiting longer each time, then leaves the URL unresolved without an exception", async () => {
    const trial = run([A], { saves: Array.from({ length: SAVE_ATTEMPTS }, () => ({ kind: "retry", evidence: "HTTP 523" }) as const) });
    const outcome = await trial.result;
    expect(trial.captured).toHaveLength(SAVE_ATTEMPTS);
    expect(trial.clock.sleeps).toEqual(expect.arrayContaining([SAVE_BACKOFF_MILLISECONDS, SAVE_BACKOFF_MILLISECONDS * 2]));
    expect(outcome.unresolved).toEqual([A]);
    expect(outcome.exceptions).toEqual([]);
    expect(trial.recorded.size).toBe(0);
  });

  it("succeeds on a retry", async () => {
    const trial = run([A], { saves: [{ kind: "retry", evidence: "HTTP 523" }, { kind: "saved", timestamp: "20261020120009" }] });
    await trial.result;
    expect(trial.recorded.get(A)).toBe("20261020120009");
  });

  it("stops without requesting more when the day's capture limit is spent", async () => {
    const trial = run([A, B], { saves: [{ kind: "saved", timestamp: "20261020120001" }], perDay: 1 });
    const outcome = await trial.result;
    expect(trial.captured).toEqual([A]);
    expect(outcome.stopped).toMatch(/capture limit/);
    expect(outcome.unresolved).toEqual([B]);
  });

  it("counts the day's captures afresh on a new UTC day", async () => {
    const trial = run([A], { saves: [{ kind: "saved", timestamp: "20261020120001" }] }, { state: { day: "2026-10-19", captures: 200 } });
    await trial.result;
    expect(trial.captured).toEqual([A]);
    expect(trial.states.at(-1)).toEqual({ day: "2026-10-20", captures: 1 });
  });

  it("stops when the account's own limit is exhausted", async () => {
    const trial = run([A, B], { saves: [{ kind: "exhausted", evidence: "error:too-many-daily-captures" }] });
    const outcome = await trial.result;
    expect(outcome.stopped).toMatch(/refused further captures/);
    expect(trial.captured).toEqual([A]);
  });

  it("stops after too many URLs in a row stay unresolved", async () => {
    const urls = Array.from({ length: MAX_CONSECUTIVE_UNRESOLVED + 2 }, (_, index) => `https://example.org/u${String(index)}`);
    const trial = run(urls, { hosts: Object.fromEntries(urls.map((url) => [url, { status: 429 }])) });
    const outcome = await trial.result;
    expect(outcome.unresolved).toHaveLength(MAX_CONSECUTIVE_UNRESOLVED);
    expect(outcome.stopped).toMatch(/in a row/);
  });

  it("skips URLs the report already excepts, unless asked to look again", async () => {
    const known: ArchiveException = { url: A, entries: ["e0"], reason: "access-wall", evidence: "HTTP 403" };
    const skipped = run([A], {}, { exceptions: [known] });
    expect((await skipped.result).exceptions).toEqual([known]);
    expect(skipped.seen).toEqual([]);
    const again = run([A], { saves: [{ kind: "saved", timestamp: "20261020120001" }] }, { exceptions: [known], retryExceptions: true });
    expect((await again.result).exceptions).toEqual([]);
    expect(again.recorded.get(A)).toBe("20261020120001");
  });

  it("keeps an exception when looking again fails for a passing reason", async () => {
    const known: ArchiveException = { url: A, entries: ["e0"], reason: "access-wall", evidence: "HTTP 403" };
    const trial = run([A], { hosts: { [A]: { status: 429 } } }, { exceptions: [known], retryExceptions: true });
    expect((await trial.result).exceptions).toEqual([known]);
  });

  it("drops an exception for a URL that now has a snapshot", async () => {
    const known: ArchiveException = { url: A, entries: ["e0"], reason: "access-wall", evidence: "HTTP 403" };
    const files = [{ path: "x", entry: entryWith("e0", [{ ...liveSource(A), snapshot: snapshotOf("20250101000000", A) }]) }];
    const trial = run([], {}, { groups: groupSources(files), exceptions: [known] });
    expect((await trial.result).exceptions).toEqual([]);
  });

  it("propagates a snapshot one entry pins to the entries that list the same URL without one", async () => {
    const files = [
      { path: "x", entry: entryWith("x", [{ ...liveSource(A), snapshot: snapshotOf("20250101000000", A) }]) },
      { path: "y", entry: entryWith("y", [liveSource(A)]) },
    ];
    const trial = run([], {}, { groups: groupSources(files) });
    await trial.result;
    expect(trial.recorded.get(A)).toBe("20250101000000");
    expect(trial.seen).toEqual([]);
  });

  it("works only on the named entries and bounds the URLs resolved", async () => {
    const named = run([A, B], { available: { [A]: "20250101000000", [B]: "20250202000000" } }, { entryIds: new Set(["e1"]) });
    await named.result;
    expect([...named.recorded.keys()]).toEqual([B]);
    const bounded = run([A, B], { available: { [A]: "20250101000000", [B]: "20250202000000" } }, { limit: 1 });
    const outcome = await bounded.result;
    expect([...bounded.recorded.keys()]).toEqual([A]);
    expect(outcome.stopped).toMatch(/limit/);
  });

  it("treats a connection failure while capturing as a retry", async () => {
    // The saver throws a RequestFailure when the network drops; the archiver must not abort the run.
    const clock = new FakeClock(NOON);
    const network = scriptedNetwork(() => new Response(JSON.stringify({ archived_snapshots: {} }), { status: 200 }));
    const { RequestFailure } = await import("./polite-client");
    const files = [{ path: "x", entry: entryWith("x", [liveSource(A)]) }];
    const outcome = await archiveSources(
      {
        client: new PoliteClient(network.fetch, clock, { ...TEST_POLITENESS, attempts: 1 }),
        saver: { limits: { capturesPerMinute: DEFAULT_PER_MINUTE, capturesPerDay: DEFAULT_PER_DAY }, save: async () => {
          await Promise.resolve();
          throw new RequestFailure("down", "ECONNRESET");
        } },
        clock,
        record: () => undefined,
        except: () => undefined,
        persist: () => undefined,
        log: () => undefined,
      },
      { groups: groupSources(files), exceptions: [], retryExceptions: false, entryIds: undefined, limit: undefined, state: { day: "", captures: 0 } },
    );
    expect(outcome.unresolved).toEqual([A]);
  });
});

describe("classifyStatus", () => {
  it("separates a wall from an error, and a busy host from both", () => {
    expect(classifyStatus(HTTP_STATUS.forbidden)).toEqual({ reason: "access-wall", evidence: "HTTP 403" });
    expect(classifyStatus(HTTP_STATUS.unauthorized)?.reason).toBe("access-wall");
    expect(classifyStatus(HTTP_STATUS.automatedClientBlocked)?.reason).toBe("access-wall");
    expect(classifyStatus(HTTP_STATUS.notFound)?.reason).toBe("source-error");
    expect(classifyStatus(HTTP_STATUS.serviceUnavailable)?.reason).toBe("source-error");
    expect(classifyStatus(HTTP_STATUS.tooManyRequests)).toBeUndefined();
  });
});

describe("archiveProblems", () => {
  const unpinned = groupSources([{ path: "x", entry: entryWith("x", [liveSource(A)]) }]);
  const known: ArchiveException = { url: A, entries: ["x"], reason: "access-wall", evidence: "HTTP 403" };

  it("fails a source that has no snapshot and no exception", () => {
    expect(archiveProblems(unpinned, [])).toEqual([expect.stringContaining(A)]);
  });

  it("accepts a source with an exception, and one with a snapshot", () => {
    expect(archiveProblems(unpinned, [known])).toEqual([]);
    expect(archiveProblems(groupSources([{ path: "x", entry: entryWith("x", [{ ...liveSource(A), snapshot: snapshotOf("20250101000000", A) }]) }]), [])).toEqual([]);
  });

  it("fails an exception for a source that is pinned, for one that is not a source, and for the wrong entries", () => {
    const pinned = groupSources([{ path: "x", entry: entryWith("x", [{ ...liveSource(A), snapshot: snapshotOf("20250101000000", A) }]) }]);
    expect(archiveProblems(pinned, [known])).toEqual([expect.stringContaining("pins a snapshot")]);
    expect(archiveProblems(unpinned, [known, { ...known, url: B }])).toEqual([expect.stringContaining(B)]);
    expect(archiveProblems(unpinned, [{ ...known, entries: ["y"] }])).toEqual([expect.stringContaining("different entries")]);
  });
});
