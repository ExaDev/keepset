import { describe, expect, it } from "vitest";
import { HTTP_STATUS } from "./http-status";
import { failureCode, MAX_RETRY_WAIT_MILLISECONDS, PoliteClient, RequestFailure, retryAfterMilliseconds, USER_AGENT } from "./polite-client";
import { at, connectionError, FakeClock, scriptedNetwork, SECOND, TEST_POLITENESS } from "./test-support";

const ok = (): Response => new Response("body", { status: HTTP_STATUS.ok });
const busy = (options: Readonly<{ status?: number; headers?: Readonly<Record<string, string>> }> = {}): Response => new Response("busy", { status: options.status ?? HTTP_STATUS.serviceUnavailable, headers: { ...options.headers } });
const unpaced = { ...TEST_POLITENESS, hostIntervalMilliseconds: 0, globalIntervalMilliseconds: 0 };
const RETRY_AFTER_SECONDS = 7;
const HUGE_RETRY_AFTER_SECONDS = 99_999;

describe("PoliteClient", () => {
  it("identifies itself with a User-Agent", async () => {
    const network = scriptedNetwork(ok);
    await new PoliteClient(network.fetch, new FakeClock(), TEST_POLITENESS).request("https://example.org/a");
    expect(at(network.seen, 0).headers.get("user-agent")).toBe(USER_AGENT);
  });

  it("tries again after a busy answer, waiting twice as long each time", async () => {
    const clock = new FakeClock();
    let calls = 0;
    const network = scriptedNetwork(() => (++calls < TEST_POLITENESS.attempts ? busy() : ok()));
    const response = await new PoliteClient(network.fetch, clock, unpaced).request("https://example.org/a");
    expect(response.status).toBe(HTTP_STATUS.ok);
    expect(network.seen).toHaveLength(TEST_POLITENESS.attempts);
    expect(clock.sleeps).toEqual([TEST_POLITENESS.backoffMilliseconds, 2 * TEST_POLITENESS.backoffMilliseconds]);
  });

  it("waits as long as Retry-After asks, up to a cap", async () => {
    const clock = new FakeClock();
    let calls = 0;
    const network = scriptedNetwork(() => {
      calls += 1;
      if (calls === 1) {
        return busy({ status: HTTP_STATUS.tooManyRequests, headers: { "retry-after": String(RETRY_AFTER_SECONDS) } });
      }

      return calls === 2 ? busy({ headers: { "retry-after": String(HUGE_RETRY_AFTER_SECONDS) } }) : ok();
    });
    await new PoliteClient(network.fetch, clock, unpaced).request("https://example.org/a");
    expect(clock.sleeps).toEqual([RETRY_AFTER_SECONDS * SECOND, MAX_RETRY_WAIT_MILLISECONDS]);
  });

  it("does not retry an answer that is not worth asking again, such as a 404", async () => {
    const network = scriptedNetwork(() => new Response("", { status: HTTP_STATUS.notFound }));
    const response = await new PoliteClient(network.fetch, new FakeClock(), TEST_POLITENESS).request("https://example.org/a");
    expect(response.status).toBe(HTTP_STATUS.notFound);
    expect(network.seen).toHaveLength(1);
  });

  it("returns the last busy answer when the attempts are used up", async () => {
    const network = scriptedNetwork(() => busy());
    const response = await new PoliteClient(network.fetch, new FakeClock(), TEST_POLITENESS).request("https://example.org/a");
    expect(response.status).toBe(HTTP_STATUS.serviceUnavailable);
    expect(network.seen).toHaveLength(TEST_POLITENESS.attempts);
  });

  it("throws a RequestFailure carrying the error code when the connection fails on every attempt", async () => {
    const network = scriptedNetwork(() => connectionError("ENOTFOUND"));
    const failure = await new PoliteClient(network.fetch, new FakeClock(), TEST_POLITENESS).request("https://example.org/a").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RequestFailure);
    expect(failure).toMatchObject({ code: "ENOTFOUND" });
    expect(network.seen).toHaveLength(TEST_POLITENESS.attempts);
  });

  it("recovers when the connection fails once and then answers", async () => {
    let calls = 0;
    const network = scriptedNetwork(() => (++calls === 1 ? connectionError("ECONNRESET") : ok()));
    const response = await new PoliteClient(network.fetch, new FakeClock(), TEST_POLITENESS).request("https://example.org/a");
    expect(response.status).toBe(HTTP_STATUS.ok);
  });

  it("spaces requests to one host by the host interval and leaves other hosts alone", async () => {
    const clock = new FakeClock();
    const times = new Map<string, number>();
    const network = scriptedNetwork((request) => {
      times.set(request.url, clock.now());

      return ok();
    });
    const client = new PoliteClient(network.fetch, clock, TEST_POLITENESS);
    await client.request("https://a.example/1");
    await client.request("https://a.example/2");
    await client.request("https://b.example/1");
    const [first, second, other] = ["https://a.example/1", "https://a.example/2", "https://b.example/1"].map((url) => times.get(url) ?? Number.NaN);
    expect((second ?? Number.NaN) - (first ?? Number.NaN)).toBeGreaterThanOrEqual(TEST_POLITENESS.hostIntervalMilliseconds);
    expect((other ?? Number.NaN) - (second ?? Number.NaN)).toBeLessThan(TEST_POLITENESS.hostIntervalMilliseconds);
  });

  it("spaces requests to different hosts by the global interval", async () => {
    const clock = new FakeClock();
    const network = scriptedNetwork(ok);
    const client = new PoliteClient(network.fetch, clock, TEST_POLITENESS);
    await client.request("https://a.example/1");
    await client.request("https://b.example/1");
    expect(clock.sleeps).toEqual([TEST_POLITENESS.globalIntervalMilliseconds]);
  });
});

describe("retryAfterMilliseconds", () => {
  const seconds = 5;
  const later = SECOND + seconds * SECOND;

  it("reads seconds and HTTP dates, and nothing else", () => {
    expect(retryAfterMilliseconds(String(seconds), 0)).toBe(seconds * SECOND);
    expect(retryAfterMilliseconds(new Date(later).toUTCString(), SECOND)).toBe(seconds * SECOND);
    expect(retryAfterMilliseconds(new Date(0).toUTCString(), SECOND)).toBe(0);
    expect(retryAfterMilliseconds("soon", 0)).toBeUndefined();
    expect(retryAfterMilliseconds(null, 0)).toBeUndefined();
  });
});

describe("failureCode", () => {
  it("finds the code on the error or on its cause, and names a timeout", () => {
    expect(failureCode(connectionError("EAI_AGAIN"))).toBe("EAI_AGAIN");
    expect(failureCode(new DOMException("timed out", "TimeoutError"))).toBe("TIMEOUT");
    expect(failureCode(new Error("plain"))).toBeUndefined();
    expect(failureCode("text")).toBeUndefined();
  });
});
