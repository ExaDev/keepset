import { describe, expect, it } from "vitest";
import { HTTP_STATUS } from "./http-status";
import { PoliteClient } from "./polite-client";
import { connectionError, FakeClock, scriptedNetwork, type Script, TEST_POLITENESS } from "./test-support";
import { CDX_URL, classifySaveError, findSnapshot, SAVE_URL, saveAnonymously, saveAuthenticated, STATUS_POLL_MILLISECONDS, WaybackBusy, WaybackError } from "./wayback";

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const single = (script: Script): { client: PoliteClient; clock: FakeClock; seen: ReturnType<typeof scriptedNetwork>["seen"] } => {
  const network = scriptedNetwork(script);
  const clock = new FakeClock();

  return { client: new PoliteClient(network.fetch, clock, { ...TEST_POLITENESS, attempts: 1 }), clock, seen: network.seen };
};
const PENDING_POLLS = 2;

describe("findSnapshot", () => {
  it("asks the capture index for the URL's latest 200 capture, encoded, and returns its timestamp", async () => {
    const { client, seen } = single(() => new Response("20260414181127\n"));
    expect(await findSnapshot(client, "https://example.org/a?b=c&d=e")).toBe("20260414181127");
    expect(seen[0]?.url).toBe(`${CDX_URL}?url=${encodeURIComponent("https://example.org/a?b=c&d=e")}&fl=timestamp&filter=statuscode%3A200&limit=-1`);
  });

  it("returns undefined when the Machine holds no capture", async () => {
    expect(await findSnapshot(single(() => new Response("")).client, "https://example.org/a")).toBeUndefined();
  });

  it("reports a refused or dropped connection as WaybackBusy", async () => {
    const dropped = new PoliteClient(scriptedNetwork(() => connectionError("ECONNREFUSED")).fetch, new FakeClock(), { ...TEST_POLITENESS, attempts: 1 });
    await expect(findSnapshot(dropped, "https://example.org/a")).rejects.toBeInstanceOf(WaybackBusy);
  });

  it("reports a busy service as WaybackBusy and a line that is not a timestamp as WaybackError", async () => {
    await expect(findSnapshot(single(() => new Response("slow down", { status: 429 })).client, "https://example.org/a")).rejects.toBeInstanceOf(WaybackBusy);
    const failure = await findSnapshot(single(() => new Response("<html>")).client, "https://example.org/a").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(WaybackError);
    expect(failure).not.toBeInstanceOf(WaybackBusy);
  });
});

describe("classifySaveError", () => {
  it("sorts documented codes into refusals, exhaustion and retries", () => {
    expect(classifySaveError("error:filesize-limit", undefined)).toEqual({ kind: "refused", reason: "size-limit", evidence: "error:filesize-limit" });
    expect(classifySaveError("error:blocked-url", undefined)).toMatchObject({ kind: "refused", reason: "excluded" });
    expect(classifySaveError("error:blocked", undefined)).toMatchObject({ kind: "refused", reason: "access-wall" });
    expect(classifySaveError("error:not-found", undefined)).toMatchObject({ kind: "refused", reason: "source-error" });
    expect(classifySaveError("error:too-many-daily-captures", undefined)).toMatchObject({ kind: "url-limited" });
    expect(classifySaveError("error:max-daily-bandwidth", undefined)).toMatchObject({ kind: "exhausted" });
    expect(classifySaveError("error:read-timeout", undefined)).toMatchObject({ kind: "retry" });
    expect(classifySaveError(undefined, "boom")).toEqual({ kind: "retry", evidence: "boom" });
  });
});

describe("saveAnonymously", () => {
  it("requests the capture with a GET of the save endpoint and reads the timestamp from the redirect", async () => {
    const { client, seen } = single(() => new Response(null, { status: 302, headers: { location: "https://web.archive.org/web/20261020221202/https://example.org/a" } }));
    expect(await saveAnonymously(client, "https://example.org/a")).toEqual({ kind: "saved", timestamp: "20261020221202" });
    expect(seen[0]).toMatchObject({ method: "GET", url: `${SAVE_URL}/https://example.org/a` });
  });

  it("reads the timestamp from Content-Location when the capture is served directly", async () => {
    const { client } = single(() => new Response("page", { status: 200, headers: { "content-location": "/web/20261020221202/https://example.org/a" } }));
    expect(await saveAnonymously(client, "https://example.org/a")).toMatchObject({ kind: "saved", timestamp: "20261020221202" });
  });

  it("refuses a URL the Machine names as excluded or blocked", async () => {
    const errors = ["RobotAccessControlException: Blocked By Robots", "AdministrativeAccessControlException: Blocked Site Error"];
    const outcomes = await Promise.all(
      errors.map(async (error) => {
        const { client } = single(() => new Response(null, { status: HTTP_STATUS.forbidden, headers: { "x-archive-wayback-runtime-error": error } }));

        return saveAnonymously(client, "https://example.org/a");
      }),
    );
    expect(outcomes).toEqual(errors.map((error) => ({ kind: "refused", reason: "excluded", evidence: error })));
  });

  it("leaves any other failure to be retried, with the status as evidence", async () => {
    const { client } = single(() => new Response("no", { status: 523 }));
    expect(await saveAnonymously(client, "https://example.org/a")).toEqual({ kind: "retry", evidence: "HTTP 523" });
  });
});

describe("saveAuthenticated", () => {
  const credentials = { accessKey: "access", secretKey: "secret" };

  it("posts the URL with the key pair, polls the job until it succeeds and returns the timestamp", async () => {
    let polls = 0;
    const { client, clock, seen } = single((request) => {
      if (request.method === "POST") {
        return json({ url: "https://example.org/a", job_id: "job-1" });
      }

      return ++polls <= PENDING_POLLS ? json({ status: "pending", job_id: "job-1" }) : json({ status: "success", job_id: "job-1", timestamp: "20261020221202" });
    });
    expect(await saveAuthenticated(client, clock, credentials, "https://example.org/a")).toEqual({ kind: "saved", timestamp: "20261020221202" });
    expect(seen[0]).toMatchObject({ method: "POST", url: SAVE_URL, body: "url=https%3A%2F%2Fexample.org%2Fa" });
    expect(seen[0]?.headers.get("authorization")).toBe("LOW access:secret");
    expect(seen[1]?.url).toBe(`${SAVE_URL}/status/job-1`);
    expect(clock.sleeps).toEqual(Array.from({ length: PENDING_POLLS + 1 }, () => STATUS_POLL_MILLISECONDS));
  });

  it("classifies a job that ends in an error", async () => {
    const { client, clock } = single((request) => (request.method === "POST" ? json({ job_id: "job-1" }) : json({ status: "error", status_ext: "error:filesize-limit", message: "too big" })));
    expect(await saveAuthenticated(client, clock, credentials, "https://example.org/a")).toMatchObject({ kind: "refused", reason: "size-limit" });
  });

  it("classifies an error returned in place of a job", async () => {
    const { client, clock } = single(() => json({ status: "error", status_ext: "error:too-many-daily-captures", message: "limit" }, HTTP_STATUS.tooManyRequests));
    expect(await saveAuthenticated(client, clock, credentials, "https://example.org/a")).toMatchObject({ kind: "url-limited" });
  });

  it("fails loudly when the key pair is rejected", async () => {
    const { client, clock } = single(() => json({ status: "error", message: "bad key" }, HTTP_STATUS.unauthorized));
    await expect(saveAuthenticated(client, clock, credentials, "https://example.org/a")).rejects.toThrow("rejected the Internet Archive key pair");
  });

  it("leaves a job that stays pending, or a page where JSON was expected, to be retried", async () => {
    const stuck = single((request) => (request.method === "POST" ? json({ job_id: "job-1" }) : json({ status: "pending" })));
    expect(await saveAuthenticated(stuck.client, stuck.clock, credentials, "https://example.org/a")).toMatchObject({ kind: "retry" });
    const html = single(() => new Response("<html>busy</html>", { status: 503 }));
    expect(await saveAuthenticated(html.client, html.clock, credentials, "https://example.org/a")).toMatchObject({ kind: "retry" });
  });

  it("never sends the key pair anywhere but the save endpoint", async () => {
    const { client, clock, seen } = single((request) => (request.method === "POST" ? json({ job_id: "job-1" }) : json({ status: "success", timestamp: "20261020221202" })));
    await saveAuthenticated(client, clock, credentials, "https://example.org/a");
    for (const request of seen) {
      expect(request.url.startsWith(SAVE_URL)).toBe(true);
      expect(request.url).not.toContain("secret");
      expect(request.body ?? "").not.toContain("secret");
    }
  });

  it("propagates a connection failure for the archiver to treat as a retry", async () => {
    const { client, clock } = single(() => connectionError("ECONNRESET"));
    await expect(saveAuthenticated(client, clock, credentials, "https://example.org/a")).rejects.toMatchObject({ code: "ECONNRESET" });
  });
});
