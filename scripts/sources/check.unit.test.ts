import { describe, expect, it } from "vitest";
import { HTTP_STATUS } from "./http-status";
import { checkReportText, checkSources, classifyProbe, type Findings, findingsOf, interleaveByHost, issueBody, needsIssue, parseCheckReport, type SourceResult } from "./check";
import { groupSources, snapshotOf } from "./entries";
import { PoliteClient } from "./polite-client";
import { connectionError, entryWith, FakeClock, liveSource, scriptedNetwork, TEST_POLITENESS } from "./test-support";

const U = "https://x.example/file";
const result = (overrides: Partial<SourceResult> & Pick<SourceResult, "url">): SourceResult => ({ entries: ["e"], recorded: "live", state: "ok", evidence: "HTTP 200", ...overrides });

describe("classifyProbe", () => {
  it("calls an answering source ok and a missing one gone", () => {
    expect(classifyProbe(U, { kind: "answered", status: 200, contentLength: 5, finalUrl: "" })).toEqual({ state: "ok", evidence: "HTTP 200" });
    expect(classifyProbe(U, { kind: "answered", status: 206, contentLength: 5, finalUrl: "" }).state).toBe("ok");
    expect(classifyProbe(U, { kind: "answered", status: 404, contentLength: undefined, finalUrl: "" })).toEqual({ state: "gone", evidence: "HTTP 404" });
    expect(classifyProbe(U, { kind: "answered", status: 410, contentLength: undefined, finalUrl: "" }).state).toBe("gone");
  });

  it("calls a source gone that redirects to the host's own missing-page page, and names the host a refusal came from", () => {
    expect(classifyProbe(U, { kind: "answered", status: HTTP_STATUS.ok, contentLength: 5, finalUrl: "https://x.example/404" })).toEqual({ state: "gone", evidence: "redirects to https://x.example/404" });
    expect(classifyProbe(U, { kind: "answered", status: HTTP_STATUS.forbidden, contentLength: undefined, finalUrl: "http://files.other.example/file" })).toEqual({ state: "blocked", evidence: "HTTP 403 from files.other.example" });
  });

  it("keeps a refusal of this client apart from a missing file, and a busy host apart from both", () => {
    expect(classifyProbe(U, { kind: "answered", status: 403, contentLength: undefined, finalUrl: "" }).state).toBe("blocked");
    expect(classifyProbe(U, { kind: "answered", status: 429, contentLength: undefined, finalUrl: "" }).state).toBe("unreachable");
    expect(classifyProbe(U, { kind: "answered", status: 503, contentLength: undefined, finalUrl: "" }).state).toBe("unreachable");
  });

  it("calls a name that no longer resolves gone and a timeout unreachable", () => {
    expect(classifyProbe(U, { kind: "unreachable", code: "ENOTFOUND" })).toEqual({ state: "gone", evidence: "ENOTFOUND" });
    expect(classifyProbe(U, { kind: "unreachable", code: "ETIMEDOUT" })).toEqual({ state: "unreachable", evidence: "ETIMEDOUT" });
    expect(classifyProbe(U, { kind: "unreachable", code: undefined })).toEqual({ state: "unreachable", evidence: "no answer" });
  });
});

describe("interleaveByHost", () => {
  it("takes one URL from each host in turn and keeps every host's own order", () => {
    const ordered = interleaveByHost(["https://a.example/1", "https://a.example/2", "https://a.example/3", "https://b.example/1", "https://c.example/1", "https://c.example/2"]);
    expect(ordered).toEqual(["https://a.example/1", "https://b.example/1", "https://c.example/1", "https://a.example/2", "https://c.example/2", "https://a.example/3"]);
  });

  it("returns exactly the URLs it was given", () => {
    const urls = ["https://a.example/1", "https://b.example/1", "https://a.example/2"];
    expect([...interleaveByHost(urls)].sort()).toEqual([...urls].sort());
    expect(interleaveByHost([])).toEqual([]);
  });
});

describe("checkSources", () => {
  const statedLength = 10;
  const concurrency = 4;
  const files = [
    { path: "a", entry: entryWith("a", [liveSource("https://one.example/ok"), liveSource("https://one.example/missing")]) },
    { path: "b", entry: entryWith("b", [liveSource("https://two.example/down"), { url: "https://three.example/old", retrieved: "2026-10-01", status: "dead", snapshot: snapshotOf("20200101000000", "https://three.example/old") }]) },
  ];

  it("probes each distinct URL once and returns the results sorted, with the stated length", async () => {
    const network = scriptedNetwork((request) => {
      if (request.url.startsWith("https://two.example")) {
        return connectionError("ENOTFOUND");
      }
      if (request.url.endsWith("/missing")) {
        return new Response(null, { status: 404 });
      }

      return new Response(null, { status: 200, headers: { "content-length": String(statedLength) } });
    });
    const results = await checkSources(new PoliteClient(network.fetch, new FakeClock(), { ...TEST_POLITENESS, attempts: 1 }), groupSources(files), concurrency);
    expect(results.map((entry) => [entry.url, entry.recorded, entry.state, entry.contentLength])).toEqual([
      ["https://one.example/missing", "live", "gone", undefined],
      ["https://one.example/ok", "live", "ok", statedLength],
      ["https://three.example/old", "dead", "ok", statedLength],
      ["https://two.example/down", "live", "gone", undefined],
    ]);
    expect(results[0]?.entries).toEqual(["a"]);
  });

  it("never edits anything: it only requests", async () => {
    const network = scriptedNetwork(() => new Response(null, { status: 200 }));
    await checkSources(new PoliteClient(network.fetch, new FakeClock(), { ...TEST_POLITENESS, attempts: 1 }), groupSources(files), 2);
    expect(new Set(network.seen.map((request) => request.method))).toEqual(new Set(["HEAD"]));
  });
});

describe("findingsOf", () => {
  const before = 100;
  const after = 250;
  const baseline = [result({ url: "https://x.example/a", contentLength: before }), result({ url: "https://x.example/b", contentLength: before })];

  it("finds live sources that no longer resolve, dead ones that answer, and lengths that changed", () => {
    const results = [
      result({ url: "https://x.example/a", contentLength: before }),
      result({ url: "https://x.example/b", contentLength: after }),
      result({ url: "https://x.example/c", state: "gone", evidence: "HTTP 404" }),
      result({ url: "https://x.example/d", state: "unreachable", evidence: "ETIMEDOUT" }),
      result({ url: "https://x.example/e", recorded: "dead" }),
      result({ url: "https://x.example/f", recorded: "dead", state: "gone", evidence: "HTTP 404" }),
      result({ url: "https://x.example/g", state: "blocked", evidence: "HTTP 403" }),
    ];
    const findings = findingsOf(results, baseline);
    expect(findings.lost.map((entry) => entry.url)).toEqual(["https://x.example/c", "https://x.example/d"]);
    expect(findings.revived.map((entry) => entry.url)).toEqual(["https://x.example/e"]);
    expect(findings.changed.map(({ result: entry, was, now }) => [entry.url, was, now])).toEqual([["https://x.example/b", before, after]]);
    expect(findings.blocked.map((entry) => entry.url)).toEqual(["https://x.example/g"]);
  });

  it("reports no change without a baseline, or where a length is missing on either side", () => {
    expect(findingsOf([result({ url: "https://x.example/a", contentLength: 5 })], []).changed).toEqual([]);
    expect(findingsOf([result({ url: "https://x.example/a" })], baseline).changed).toEqual([]);
  });
});

describe("needsIssue and issueBody", () => {
  const empty: Findings = { lost: [], revived: [], changed: [], blocked: [] };
  const lost = result({ url: "https://x.example/c", entries: ["one", "two"], state: "gone", evidence: "HTTP 404" });

  it("asks for an issue for a lost, revived or changed source, and not for a source that only refuses this client", () => {
    expect(needsIssue(empty)).toBe(false);
    expect(needsIssue({ ...empty, blocked: [lost] })).toBe(false);
    expect(needsIssue({ ...empty, lost: [lost] })).toBe(true);
    expect(needsIssue({ ...empty, revived: [lost] })).toBe(true);
    expect(needsIssue({ ...empty, changed: [{ result: lost, was: 1, now: 2 }] })).toBe(true);
  });

  it("names each source, its entries and what was observed", () => {
    const body = issueBody({ ...empty, lost: [lost], changed: [{ result: lost, was: 100, now: 250 }] });
    expect(body).toContain("- https://x.example/c (one, two): gone, HTTP 404");
    expect(body).toContain("100 bytes, now 250");
    expect(body).not.toContain("answering again");
  });

  it("is free of spaced double hyphens and em-dashes", () => {
    const body = issueBody({ lost: [lost], revived: [lost], changed: [{ result: lost, was: 1, now: 2 }], blocked: [lost] });
    expect(body).not.toMatch(/\s--\s|\u2014/);
  });
});

describe("the check report", () => {
  it("round-trips through its text, sorted keys and all", () => {
    const results = [result({ url: "https://x.example/a", contentLength: 7 }), result({ url: "https://x.example/b", state: "gone", evidence: "HTTP 404" })];
    const text = checkReportText(results);
    expect(parseCheckReport(text)).toEqual(results);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("refuses text that is not a report", () => {
    expect(() => parseCheckReport("{}")).toThrow();
  });
});
