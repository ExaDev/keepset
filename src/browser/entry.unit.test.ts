import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCatalogue } from "../catalogue";
import type { Dataset } from "../catalogue";
import { fixtureIndex, liveEntry } from "../test-support/entries";
import { fetchEntry } from "./entry";

const datasetWith = (entry: unknown): Dataset => createCatalogue({ ...fixtureIndex, entries: [entry] }).listDatasets()[0] ?? expect.unreachable("the fixture catalogue lists its one entry");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the browser entry point", () => {
  it("fetches through the platform's downloader and hashes with SubtleCrypto, matching the recorded digest", async () => {
    const body = "% karate excerpt\n1 2\n2 3\n3 1\n";
    vi.stubGlobal("fetch", (() => new Response(body, { status: 200, headers: { "content-length": String(body.length) } })));
    const fetched = await fetchEntry(datasetWith(liveEntry), {});
    expect(fetched.data).toEqual(expect.objectContaining({ nodes: [{ id: "1" }, { id: "2" }, { id: "3" }], edges: [{ source: "1", target: "2" }, { source: "2", target: "3" }, { source: "3", target: "1" }] }));
    expect(fetched.provenance).toMatchObject({ sha256: createHash("sha256").update(body).digest("hex"), byteLength: body.length });
  });

});
