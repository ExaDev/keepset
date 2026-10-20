import { describe, expect, it } from "vitest";
import { HTTP_STATUS } from "./http-status";
import { PoliteClient } from "./polite-client";
import { isDefinitiveFailure, probe, redirectsToMissingPage, statedLength, statusEvidence } from "./probe";
import { connectionError, FakeClock, scriptedNetwork, type Script, TEST_POLITENESS } from "./test-support";

const clientFor = (script: Script): { client: PoliteClient; methods: () => string[] } => {
  const network = scriptedNetwork(script);

  return { client: new PoliteClient(network.fetch, new FakeClock(), { ...TEST_POLITENESS, attempts: 1 }), methods: () => network.seen.map((request) => request.method) };
};

describe("probe", () => {
  it("takes the length from a HEAD answer and asks nothing more", async () => {
    const { client, methods } = clientFor(() => new Response(null, { status: 200, headers: { "content-length": "1234" } }));
    expect(await probe(client, "https://example.org/a")).toMatchObject({ kind: "answered", status: 200, contentLength: 1234 });
    expect(methods()).toEqual(["HEAD"]);
  });

  it("asks for the first byte when HEAD is refused, and reads the length from Content-Range", async () => {
    const { client, methods } = clientFor((request) => (request.method === "HEAD" ? new Response(null, { status: 405 }) : new Response("x", { status: 206, headers: { "content-range": "bytes 0-0/9876" } })));
    expect(await probe(client, "https://example.org/a")).toMatchObject({ kind: "answered", status: 206, contentLength: 9876 });
    expect(methods()).toEqual(["HEAD", "GET"]);
  });

  it("sends the range request with a Range header and asks for the stored representation", async () => {
    const network = scriptedNetwork((request) => (request.method === "HEAD" ? new Response(null, { status: 403 }) : new Response("x", { status: 206, headers: { "content-range": "bytes 0-0/5" } })));
    await probe(new PoliteClient(network.fetch, new FakeClock(), { ...TEST_POLITENESS, attempts: 1 }), "https://example.org/a");
    expect(network.seen[1]?.headers.get("range")).toBe("bytes=0-0");
    expect(network.seen[1]?.headers.get("accept-encoding")).toBe("identity");
  });

  it("takes the GET answer over a HEAD answer that was wrong", async () => {
    const { client } = clientFor((request) => (request.method === "HEAD" ? new Response(null, { status: 404 }) : new Response("x", { status: 200, headers: { "content-length": "7" } })));
    expect(await probe(client, "https://example.org/a")).toMatchObject({ status: 200, contentLength: 7 });
  });

  it("reports the final error status when both requests are refused", async () => {
    const { client } = clientFor(() => new Response(null, { status: 404 }));
    expect(await probe(client, "https://example.org/a")).toMatchObject({ kind: "answered", status: 404 });
  });

  it("falls back to GET when the HEAD connection fails", async () => {
    const { client, methods } = clientFor((request) => (request.method === "HEAD" ? connectionError("ECONNRESET") : new Response("x", { status: 200 })));
    expect(await probe(client, "https://example.org/a")).toMatchObject({ kind: "answered", status: 200 });
    expect(methods()).toEqual(["HEAD", "GET"]);
  });

  it("reports the code when the host cannot be reached by either request", async () => {
    const { client } = clientFor(() => connectionError("ENOTFOUND"));
    expect(await probe(client, "https://example.org/a")).toEqual({ kind: "unreachable", code: "ENOTFOUND" });
  });
});

describe("statedLength", () => {
  const length = 42;

  it("prefers the total of a partial answer and ignores a length it cannot read", () => {
    expect(statedLength({ status: 206, headers: new Headers({ "content-range": `bytes 0-0/${String(length)}`, "content-length": "1" }) })).toBe(length);
    expect(statedLength({ status: 206, headers: new Headers({ "content-range": "bytes 0-0/*" }) })).toBeUndefined();
    expect(statedLength({ status: 200, headers: new Headers({ "content-length": String(length) }) })).toBe(length);
    expect(statedLength({ status: 200, headers: new Headers({ "content-length": "many" }) })).toBeUndefined();
    expect(statedLength({ status: 200, headers: new Headers() })).toBeUndefined();
  });
});

describe("isDefinitiveFailure", () => {
  it("counts a missing name, a refusal and a bad certificate, not a timeout or a reset", () => {
    for (const code of ["ENOTFOUND", "ECONNREFUSED", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT"]) {
      expect(isDefinitiveFailure(code), code).toBe(true);
    }
    for (const code of ["ETIMEDOUT", "ECONNRESET", "UND_ERR_CONNECT_TIMEOUT", "TIMEOUT", undefined]) {
      expect(isDefinitiveFailure(code), String(code)).toBe(false);
    }
  });
});

describe("redirectsToMissingPage", () => {
  const requested = "https://example.org/data/file.gz";

  it("recognises a redirect to a missing-page path, and nothing else", () => {
    expect(redirectsToMissingPage(requested, "https://example.org/404")).toBe(true);
    expect(redirectsToMissingPage(requested, "https://example.org/errors/Not-Found/index.html")).toBe(true);
    expect(redirectsToMissingPage(requested, "https://example.org/data/file2.gz")).toBe(false);
    expect(redirectsToMissingPage(requested, "https://example.org/data/404x.gz")).toBe(false);
  });

  it("does not count a request that stayed where it was or whose final URL is unknown", () => {
    expect(redirectsToMissingPage("https://example.org/404", "https://example.org/404")).toBe(false);
    expect(redirectsToMissingPage(requested, "")).toBe(false);
  });
});

describe("statusEvidence", () => {
  it("names the host an answer came from only when redirects led to another one", () => {
    expect(statusEvidence(HTTP_STATUS.forbidden, "https://a.example/x", "https://a.example/y")).toBe("HTTP 403");
    expect(statusEvidence(HTTP_STATUS.forbidden, "https://a.example/x", "http://b.example/y")).toBe("HTTP 403 from b.example");
    expect(statusEvidence(HTTP_STATUS.forbidden, "https://a.example/x", "")).toBe("HTTP 403");
  });
});
