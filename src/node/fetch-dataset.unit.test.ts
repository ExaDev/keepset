import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCatalogue, type Dataset } from "../catalogue";
import { DatasetNotFoundError, KeepsetError, RecipeError, type RecipeStep } from "../errors";
import { gzip, tar, zip } from "../test-support/archives";
import { arcgisEntry, deadEntry, fixtureIndex, liveEntry, notFetchableEntry, orEntry, socrataEntry } from "../test-support/entries";
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

/** An epoch-millisecond date of the paged layer's features, which the parser writes as ISO 8601 text. */
const EPOCH_MILLISECONDS = 1_700_000_000_000;
/** What the paged layer's three features are: their fines, their positions (longitude first, as the file writes it) and the number of features. */
const FINES = { first: 50, third: 75.5 } as const;
const HERE = { longitude: -0.1, latitude: 51.5 } as const;
const THERE = { longitude: -1.5, latitude: 52 } as const;
const FEATURES = 3;
/** How many times the downloader requests a page before it gives up. */
const PAGE_ATTEMPTS = 3;

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

describe("an or/v1 entry whose source is a paged ArcGIS layer", () => {
  const layer = "https://example.org/arcgis/rest/services/Violations/FeatureServer/0";
  const feature = (id: number, fine: number | null, kind: string | null, point: { readonly longitude: number; readonly latitude: number } | null): unknown => ({
    type: "Feature",
    id,
    geometry: point === null ? null : { type: "Point", coordinates: [point.longitude, point.latitude] },
    properties: { OBJECTID: id, FINE: fine, OPENED: EPOCH_MILLISECONDS + id, KIND: kind, PRIVATE: "not kept" },
  });
  const features = [feature(1, FINES.first, "Weeds", HERE), feature(2, null, "Parking", null), feature(FEATURES, FINES.third, null, THERE)];
  const dataset = datasetWith(arcgisEntry);

  /** A stand-in layer that answers its count and pages of `size` features by offset, the way a feature server does, and records every request. */
  function layerServing(all: readonly unknown[], size: number, overrides: Readonly<Record<string, Response>> = {}): { fetch: FetchPort; requested: string[] } {
    const requested: string[] = [];
    const fetch: FetchPort = async (url) => {
      requested.push(url);
      const override = Object.entries(overrides).find(([part]) => url.includes(part));
      if (override !== undefined) {
        return Promise.resolve(override[1].clone());
      }
      if (url.includes("returnCountOnly=true")) {
        return Promise.resolve(Response.json({ count: all.length }));
      }
      const offset = Number(/resultOffset=(\d+)/.exec(url)?.[1]);

      return Promise.resolve(Response.json({ type: "FeatureCollection", features: all.slice(offset, offset + size) }));
    };

    return { fetch, requested };
  }

  it("reads every page in order of the order-by field and resolves or/v1 from the one collection", async () => {
    const served = layerServing(features, 2);
    const fetched = await fetchEntry(dataset, { fetch: served.fetch, now });
    expect(fetched.warnings).toEqual([]);
    expect(fetched.data).toEqual({
      meta: { id: "layer-violations", name: "Layer violations" },
      nodes: [
        { id: "1", lat: HERE.latitude, lon: HERE.longitude, prize: FINES.first, opened: "2023-11-14T22:13:20.001Z", skill: "Weeds" },
        { id: "2", lat: null, lon: null, prize: null, opened: "2023-11-14T22:13:20.002Z", skill: "Parking" },
        { id: "3", lat: THERE.latitude, lon: THERE.longitude, prize: FINES.third, opened: "2023-11-14T22:13:20.003Z", skill: null },
      ],
    });
    expect(JSON.stringify(fetched.data)).not.toContain("not kept");
    expect(served.requested).toHaveLength(FEATURES);
    expect(served.requested[1]).toContain("orderByFields=OBJECTID&resultOffset=0&f=geojson");
    expect(served.requested[2]).toContain("resultOffset=2");
    expect(fetched.provenance.fetchedUrl).toBe(layer);
    expect(fetched.provenance.byteLength).toBeGreaterThan(0);
  });

  it("holds the round trip over the paths the crosswalk maps", async () => {
    expect(await roundTripEntry(dataset, { fetch: layerServing(features, 2).fetch, now })).toMatchObject({ holds: true });
  });

  it("fails at the download step, and does not loop, when the layer ignores the offset", async () => {
    const stuck = layerServing(features, 2, { "resultOffset=2": Response.json({ type: "FeatureCollection", features: [] }) });
    const error = await failure(fetchEntry(dataset, { fetch: stuck.fetch, now }));
    expect(error.step).toBe("download");
    expect(error.message).toMatch(/gave no features at offset 2, before the 3 it reports/);
  });

  it("fails at the download step when the server answers an error in a 200 response, or reports no count", async () => {
    const refused = layerServing(features, 2, { returnCountOnly: Response.json({ error: { code: 499, message: "Token Required" } }) });
    expect((await failure(fetchEntry(dataset, { fetch: refused.fetch, now }))).message).toMatch(/Token Required/);
    const noCount = layerServing(features, 2, { returnCountOnly: Response.json({ unrelated: true }) });
    expect((await failure(fetchEntry(dataset, { fetch: noCount.fetch, now }))).message).toMatch(/did not report a feature count/);
  });
});

describe("an or/v1 entry whose source is a Socrata resource read in pages", () => {
  const resource = "https://data.example.org/resource/abcd-1234.csv";
  const header = "case_id,status,borough,note\n";
  const rows = ["a1,Open,Camden,x\n", 'a2,Closed,"Isle ""of"" Dogs","two\nlines"\n', "a3,Open,Hackney,\n"];
  const dataset = datasetWith(socrataEntry);

  /** A stand-in resource that answers its count and pages by offset, the way Socrata does, and records every request; `page` overrides what a page of a given offset says. */
  function resourceServing(all: readonly string[], overrides: { readonly page?: (offset: number, honest: string) => string; readonly count?: string } = {}): { fetch: FetchPort; requested: string[] } {
    const { page = (_offset: number, honest: string): string => honest, count = `"count"\n"${String(all.length)}"\n` } = overrides;
    const requested: string[] = [];
    const fetch: FetchPort = async (url) => {
      requested.push(url);
      if (url.includes("select=count")) {
        return Promise.resolve(new Response(count));
      }
      const offset = Number(/offset=(\d+)/.exec(url)?.[1]);
      const limit = Number(/limit=(\d+)/.exec(url)?.[1]);

      return Promise.resolve(new Response(page(offset, header + all.slice(offset, offset + limit).join(""))));
    };

    return { fetch, requested };
  }

  it("reads each page in order of the row ids and joins them under one header", async () => {
    const served = resourceServing(rows);
    const fetched = await fetchEntry(dataset, { fetch: served.fetch, now });
    expect(fetched.data).toEqual({
      meta: { id: "resource-cases", name: "Resource cases" },
      nodes: [
        { id: "a1", status: "Open", territory: "Camden" },
        { id: "a2", status: "Closed", territory: 'Isle "of" Dogs' },
        { id: "a3", status: "Open", territory: "Hackney" },
      ],
    });
    expect(served.requested).toEqual([`${resource}?%24select=count(*)`, `${resource}?%24order=%3Aid&%24limit=2&%24offset=0`, `${resource}?%24order=%3Aid&%24limit=2&%24offset=2`]);
    expect(fetched.provenance.fetchedUrl).toBe(resource);
    expect(fetched.provenance.byteLength).toBe(new TextEncoder().encode(header + rows.join("")).length);
  });

  it("holds the round trip over the paths the crosswalk maps", async () => {
    expect(await roundTripEntry(dataset, { fetch: resourceServing(rows).fetch, now })).toMatchObject({ holds: true });
  });

  it("fails at the download step when a page holds fewer rows than it should, as a response cut short does", async () => {
    const cut = resourceServing(rows, { page: (offset, honest) => (offset === 2 ? header : honest) });
    const error = await failure(fetchEntry(dataset, { fetch: cut.fetch, now }));
    expect(error.step).toBe("download");
    expect(error.message).toMatch(/gave 0 rows at offset 2 where 1 of its 3 were due/);
  });

  it("asks a page again when one response is cut short or fails, and fails only when it keeps failing", async () => {
    const attempts = new Map<number, number>();
    const flaky = resourceServing(rows, {
      page: (offset, honest) => {
        const seen = (attempts.get(offset) ?? 0) + 1;
        attempts.set(offset, seen);

        return offset === 2 && seen < PAGE_ATTEMPTS ? header : honest;
      },
    });
    const fetched = await fetchEntry(dataset, { fetch: flaky.fetch, now });
    expect(fetched.data).toMatchObject({ nodes: [{ id: "a1" }, { id: "a2" }, { id: "a3" }] });
    expect(attempts.get(2)).toBe(PAGE_ATTEMPTS);
    const hopeless = resourceServing(rows, { page: (offset, honest) => (offset === 2 ? header : honest) });
    expect((await failure(fetchEntry(dataset, { fetch: hopeless.fetch, now }))).message).toMatch(/gave 0 rows at offset 2/);
    expect(hopeless.requested.filter((url) => url.includes("offset=2"))).toHaveLength(PAGE_ATTEMPTS);
  });

  it("fails at the download step when a later page has a different header, or the resource reports no rows or no count", async () => {
    const changed = resourceServing(rows, { page: (offset, honest) => (offset === 2 ? honest.replace("status", "state") : honest) });
    expect((await failure(fetchEntry(dataset, { fetch: changed.fetch, now }))).message).toMatch(/different header at offset 2/);
    expect((await failure(fetchEntry(dataset, { fetch: resourceServing([]).fetch, now }))).message).toMatch(/has no rows/);
    expect((await failure(fetchEntry(dataset, { fetch: resourceServing(rows, { count: "unrelated" }).fetch, now }))).message).toMatch(/did not report a row count/);
  });
});
