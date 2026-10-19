import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCatalogue, type Dataset } from "../catalogue";
import { DatasetNotFoundError, KeepsetError, RecipeError, type RecipeStep } from "../errors";
import { gzip, tar, zip } from "../test-support/archives";
import { deadEntry, fixtureIndex, liveEntry, notFetchableEntry, orEntry } from "../test-support/entries";
import { downloadUrl, fetchDataset, fetchEntry, roundTripDataset, roundTripEntry, type FetchPort } from "./fetch-dataset";

const karateText = "% karate excerpt\n1 2\n2 3\n3 1\n";

/** A network port that serves fixed bytes by URL and records every request, standing in for the platform fetch so no test touches the network. */
function servedBy(files: Readonly<Record<string, Uint8Array | string>>): { fetch: FetchPort; requested: string[] } {
  const requested: string[] = [];
  const fetch: FetchPort = async (url) => {
    requested.push(url);
    const body = Object.hasOwn(files, url) ? files[url] : undefined;

    return Promise.resolve(body === undefined ? new Response("missing", { status: 404, statusText: "Not Found" }) : new Response(body));
  };

  return { fetch, requested };
}

const now = (): Date => new Date("2026-10-18T12:00:00.000Z");

const datasetWith = (entry: unknown): Dataset => createCatalogue({ ...fixtureIndex, entries: [entry] }).listDatasets()[0] ?? expect.unreachable("the fixture catalogue lists its one entry");

async function failure(run: Readonly<Promise<unknown>>): Promise<RecipeError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof RecipeError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a RecipeError");
}

describe("fetchEntry", () => {
  it("downloads a live source, parses it, applies the crosswalk and resolves graph/v1", async () => {
    const { fetch, requested } = servedBy({ "https://example.org/data/karate.txt": karateText });
    const result = await fetchEntry(datasetWith(liveEntry), { fetch, now });
    expect(requested).toEqual(["https://example.org/data/karate.txt"]);
    expect(result.data).toEqual({
      meta: { id: "karate", name: "Zachary Karate Club", directed: false, weighted: false, density: 0.139 },
      nodes: [{ id: "1" }, { id: "2" }, { id: "3" }],
      edges: [
        { source: "1", target: "2" },
        { source: "2", target: "3" },
        { source: "3", target: "1" },
      ],
    });
    expect(result.provenance).toEqual({
      entryId: "karate",
      catalogue: { id: "fixture", version: "1.2.3" },
      category: "graph/v1",
      source: { url: "https://example.org/data/karate.txt", status: "live" },
      fetchedUrl: "https://example.org/data/karate.txt",
      retrievedAt: "2026-10-18T12:00:00.000Z",
      sha256: createHash("sha256").update(karateText).digest("hex"),
      byteLength: karateText.length,
    });
  });

  it("warns, without failing, when a fetched count differs from the one the entry records", async () => {
    const { fetch } = servedBy({ "https://example.org/data/karate.txt": karateText });
    const result = await fetchEntry(datasetWith(liveEntry), { fetch, now });
    expect(result.warnings).toEqual(["nodes: the entry records 34, the fetched result has 3", "edges: the entry records 78, the fetched result has 3"]);
    const exact = await fetchEntry(datasetWith({ ...liveEntry, expectedCounts: { nodes: 3, edges: 3 } }), { fetch, now });
    expect(exact.warnings).toEqual([]);
  });

  it("fetches a dead source from its pinned snapshot's raw form and records the archive member", async () => {
    const pajek = "*Vertices 2\n*Edges\n1 2\n";
    const archived = "https://web.archive.org/web/20230601id_/http://example.edu/~lab/data/celegans_metabolic.zip";
    const zipped = zip([{ path: "data/celegans_metabolic.net", text: pajek }]);
    const { fetch, requested } = servedBy({ [archived]: zipped });
    const result = await fetchEntry(datasetWith(deadEntry), { fetch, now });
    expect(requested).toEqual([archived]);
    expect("edges" in result.data && result.data.edges).toEqual([{ source: "1", target: "2" }]);
    expect(result.provenance).toMatchObject({ fetchedUrl: archived, member: "data/celegans_metabolic.net", source: { status: "dead", snapshot: { timestamp: "20230601" } } });
  });

  it("unpacks a tar.gz source before parsing", async () => {
    const entry = {
      ...liveEntry,
      recipe: { status: "fetchable", source: 0, archive: { kind: "tar.gz", member: { path: "karate/karate.mtx" } }, parser: { format: "matrix-market", encoding: "utf-8" } },
    };
    const mtx = "%%MatrixMarket matrix coordinate pattern symmetric\n3 3 2\n2 1\n3 1\n";
    const { fetch } = servedBy({ "https://example.org/data/karate.txt": gzip(tar([{ path: "karate/karate.mtx", text: mtx }])) });
    expect((await fetchEntry(datasetWith(entry), { fetch, now })).data.nodes.map((node) => node.id)).toEqual(["1", "2", "3"]);
  });

  it("passes the abort signal to the network port", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const fetch: FetchPort = async (_url, init) => {
      seen = init.signal;

      return Promise.resolve(new Response(karateText));
    };
    await fetchEntry(datasetWith(liveEntry), { fetch, now, signal: controller.signal });
    expect(seen).toBe(controller.signal);
  });

  const failures: readonly { readonly step: RecipeStep; readonly entry: unknown; readonly body?: string | Uint8Array; readonly fetch?: FetchPort; readonly message: RegExp }[] = [
    { step: "recipe", entry: notFetchableEntry, message: /requires an account/ },
    { step: "download", entry: liveEntry, message: /answered 404 Not Found/ },
    {
      step: "download",
      entry: liveEntry,
      fetch: async () => Promise.reject(new TypeError("fetch failed")),
      message: /fetch failed/,
    },
    { step: "extract", entry: { ...liveEntry, recipe: { ...liveEntry.recipe, archive: { kind: "gzip" } } }, body: karateText, message: /not valid gzip/ },
    { step: "parse", entry: liveEntry, body: "1 2\nlonely\n", message: /line 2/ },
    {
      step: "crosswalk",
      entry: { ...liveEntry, crosswalk: { ...liveEntry.crosswalk, rules: [...liveEntry.crosswalk.rules, { op: "move", from: "absent", to: "present" }] } },
      body: karateText,
      message: /absent/,
    },
    {
      step: "validate",
      entry: { ...liveEntry, recipe: { ...liveEntry.recipe, parser: { format: "gml", encoding: "utf-8" } } },
      body: "graph [ node [ id 1 ] edge [ source 1 target 2 ] ]",
      message: /names no node/,
    },
  ];

  it.each(failures)("fails loudly at the $step step, naming the entry", async ({ step, entry, body, fetch, message }) => {
    const port = fetch ?? servedBy(body === undefined ? {} : { "https://example.org/data/karate.txt": body, "https://example.com/datasets/walled": body }).fetch;
    const error = await failure(fetchEntry(datasetWith(entry), { fetch: port, now }));
    expect(error.step).toBe(step);
    expect(error.entryId).toMatch(/^(karate|auth-walled)$/);
    expect(error.message).toMatch(message);
    expect(error).toBeInstanceOf(KeepsetError);
  });
});

describe("downloadUrl", () => {
  it("uses a live source's own URL even when it pins a snapshot", () => {
    expect(downloadUrl({ url: "https://example.org/a", retrieved: "2026-01-01", status: "live", snapshot: { url: "https://web.archive.org/web/20200101/https://example.org/a", timestamp: "20200101" } })).toBe("https://example.org/a");
  });
});

describe("fetchDataset", () => {
  it("resolves ids against the bundled catalogue", async () => {
    await expect(fetchDataset("no-such-entry")).rejects.toThrow(DatasetNotFoundError);
  });
});

describe("roundTripEntry", () => {
  it("holds when the crosswalk preserves every path of the native document", async () => {
    const { fetch } = servedBy({ "https://example.org/data/karate.txt": karateText });
    const report = await roundTripEntry(datasetWith(liveEntry), { fetch, now });
    expect(report).toMatchObject({ holds: true, provenance: { entryId: "karate" } });
  });

  it("reports the first path a lossy crosswalk loses", async () => {
    const { fetch } = servedBy({ "https://example.org/data/karate.txt": karateText });
    const withoutMeta = { ...liveEntry, crosswalk: { ...liveEntry.crosswalk, rules: liveEntry.crosswalk.rules.filter((rule) => rule.from !== "meta") } };
    const report = await roundTripEntry(datasetWith(withoutMeta), { fetch, now });
    // twindex names the record whose keys differ, here the document root.
    expect(report).toMatchObject({ holds: false, path: "" });
    expect(report.holds ? "" : report.message).toMatch(/records differ in keys: edges,meta,nodes against edges,nodes/);
  });

  it("fails loudly when the recipe fails before the comparison", async () => {
    const error = await failure(roundTripEntry(datasetWith(notFetchableEntry), { now }));
    expect(error.step).toBe("recipe");
  });

  it("resolves ids against the bundled catalogue", async () => {
    await expect(roundTripDataset("no-such-entry")).rejects.toThrow(DatasetNotFoundError);
  });
});

describe("an or/v1 entry", () => {
  const csv = 'request_id,latitude,longitude,minutes,status,borough,private_note\na1,51.5,-0.1,2,Open,Camden,not shared\na2,,,3,Closed,,\n"a,3",52,-1.5,,Open,"Isle ""of"" Dogs",\n';
  const { fetch: port } = servedBy({ "https://example.org/data/requests.csv": csv });
  const dataset = datasetWith(orEntry);

  it("downloads a table, parses it, applies the crosswalk and resolves or/v1 with only the mapped fields", async () => {
    const fetched = await fetchEntry(dataset, { fetch: port, now });
    expect(fetched.warnings).toEqual([]);
    expect(fetched.data).toEqual({
      meta: { id: "service-requests", name: "Service requests", durationUnit: "seconds" },
      nodes: [
        { id: "a1", lat: 51.5, lon: -0.1, duration: 120, status: "Open", territory: "Camden" },
        { id: "a2", lat: null, lon: null, duration: 180, status: "Closed", territory: null },
        { id: "a,3", lat: 52, lon: -1.5, duration: null, status: "Open", territory: 'Isle "of" Dogs' },
      ],
    });
    expect(JSON.stringify(fetched.data)).not.toContain("not shared");
  });

  it("holds the round trip over the paths the crosswalk maps", async () => {
    expect(await roundTripEntry(dataset, { fetch: port, now })).toMatchObject({ holds: true });
  });

  it("fails at the validate step when a value is outside the target's range", async () => {
    const bad = servedBy({ "https://example.org/data/requests.csv": "request_id,latitude,longitude,minutes,status,borough\nx,95,0,1,Open,A\n" });
    const error = await failure(fetchEntry(dataset, { fetch: bad.fetch, now }));
    expect(error.step).toBe("validate");
    expect(error.message).toMatch(/lat/);
  });

  it("fails at the parse step, naming the line, when the table is malformed", async () => {
    const bad = servedBy({ "https://example.org/data/requests.csv": "request_id,latitude,longitude,minutes,status,borough\nx,1,0,notanumber,Open,A\n" });
    const error = await failure(fetchEntry(dataset, { fetch: bad.fetch, now }));
    expect(error.step).toBe("parse");
    expect(error.message).toMatch(/line 2/);
  });
});
