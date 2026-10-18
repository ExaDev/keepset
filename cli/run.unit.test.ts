import { createCatalogue, DatasetNotFoundError, RecipeError, type Dataset, type DatasetQuery } from "keepset";
import type { FetchedDataset, RoundTripReport } from "keepset/node";
import { describe, expect, it } from "vitest";
import { fixtureIndex } from "../src/test-support/entries";
import { EXIT_FAILED, EXIT_NO, EXIT_OK, formatSearch, formatShow, provenancePath, run, type CliIo, type CliLibrary } from "./run";

const catalogue = createCatalogue(fixtureIndex);
const karate = catalogue.getDataset("karate");
const walled = catalogue.getDataset("auth-walled");

/** A SHA-256 is 64 hex digits. */
const SHA256_DIGITS = 64;

const fetched: FetchedDataset = {
  dataset: karate,
  data: { meta: { id: "karate", name: "Zachary Karate Club" }, nodes: [{ id: "1" }, { id: "2" }], edges: [{ source: "1", target: "2" }] },
  provenance: {
    entryId: "karate",
    catalogue: karate.catalogue,
    category: "graph/v1",
    source: { url: "https://example.org/data/karate.txt", status: "live" },
    fetchedUrl: "https://example.org/data/karate.txt",
    retrievedAt: "2026-10-18T12:00:00.000Z",
    sha256: "0".repeat(SHA256_DIGITS),
    byteLength: 4,
  },
  warnings: ["nodes: the entry records 34, the fetched result has 2"],
};

/** A library stand-in that records each call, so the tests exercise the command layer alone. */
function harness(overrides: Partial<CliLibrary> = {}) {
  const calls: unknown[][] = [];
  const library: CliLibrary = {
    listDatasets: (query: DatasetQuery) => {
      calls.push(["listDatasets", query]);

      return catalogue.listDatasets(query);
    },
    getDataset: (id: string): Dataset => {
      calls.push(["getDataset", id]);

      return catalogue.getDataset(id);
    },
    validateDataset: () => [],
    fetchDataset: async (id) => {
      calls.push(["fetchDataset", id]);

      return Promise.resolve(fetched);
    },
    roundTripDataset: async (id): Promise<RoundTripReport> => {
      calls.push(["roundTripDataset", id]);

      return Promise.resolve({ holds: true, provenance: fetched.provenance });
    },
    countTarget: () =>
      new Map([
        ["nodes", 2],
        ["edges", 1],
      ]),
    ...overrides,
  };
  const out = { stdout: "", stderr: "", files: new Map<string, string>() };
  const io: CliIo = {
    writeStdout: (text) => {
      out.stdout += text;
    },
    writeStderr: (text) => {
      out.stderr += text;
    },
    writeFile: (path, text) => {
      out.files.set(path, text);
    },
    version: "9.9.9",
  };

  return { library, io, out, calls };
}

describe("command parsing", () => {
  it("prints the version and the help", async () => {
    const version = harness();
    expect(await run(["--version"], version.library, version.io)).toBe(EXIT_OK);
    expect(version.out.stdout).toBe("9.9.9\n");
    const help = harness();
    expect(await run(["-h"], help.library, help.io)).toBe(EXIT_OK);
    expect(help.out.stdout).toMatch(/^Usage: keepset <command>/);
  });

  it.each([
    [[], /expected a command/],
    [["teleport", "x"], /unknown command teleport/],
    [["show"], /show takes exactly one dataset id/],
    [["fetch", "a", "b"], /fetch takes exactly one dataset id/],
    [["search", "a", "b"], /at most one text argument/],
    [["search", "--nope"], /Unknown option '--nope'/],
    [["fetch", "karate", "--out"], /argument missing/],
  ])("rejects %j with usage and exit status 2", async (args, message) => {
    const { library, io, out, calls } = harness();
    expect(await run(args, library, io)).toBe(EXIT_FAILED);
    expect(out.stderr).toMatch(message);
    expect(out.stderr).toMatch(/Usage: keepset/);
    expect(calls).toEqual([]);
  });
});

describe("search", () => {
  it("passes the text and every filter to listDatasets", async () => {
    const { library, io, calls } = harness();
    await run(["search", "elegans", "--kind", "graph", "--domain", "Ecology", "--category", "graph/v1"], library, io);
    expect(calls).toEqual([["listDatasets", { text: "elegans", kind: "graph", domain: "Ecology", category: "graph/v1" }]]);
  });

  it("prints one tab-separated line per dataset, or the entries as JSON", async () => {
    const human = harness();
    expect(await run(["search", "karate"], human.library, human.io)).toBe(EXIT_OK);
    expect(human.out.stdout).toBe("karate\tZachary Karate Club\tgraph/v1\tfetchable\n");
    const machine = harness();
    await run(["search", "--json"], machine.library, machine.io);
    expect(JSON.parse(machine.out.stdout)).toEqual(catalogue.listDatasets().map((dataset) => dataset.entry));
  });

  it("formats every dataset in the order given", () => {
    expect(formatSearch([walled, karate])).toBe("auth-walled\tC. elegans metabolic network\tgraph/v1\tnot-fetchable\nkarate\tZachary Karate Club\tgraph/v1\tfetchable\n");
  });
});

describe("show", () => {
  it("prints the descriptor, sources, licence, citations, recipe and crosswalk", () => {
    const text = formatShow(karate);
    for (const line of [
      "Zachary Karate Club (karate)",
      "category: graph/v1 (kind graph)",
      "licence: not recorded by the source",
      "  [0] https://example.org/data/karate.txt (live, retrieved 2026-04-19)",
      "doi:10.1086/jar.33.4.3629752",
      "  archive: none",
      "  parser: edge-list",
      "crosswalk: edge-list -> graph/v1",
      "  move nodes[].id -> nodes[].id",
      "expected counts: nodes 34, edges 78",
      "  density: 0.139",
    ]) {
      expect(text).toContain(line);
    }
  });

  it("says why a dataset is not fetchable, and names a custom licence", () => {
    const text = formatShow(walled);
    expect(text).toContain("not fetchable: the source requires an account to download");
    expect(text).toContain("licence: Example data licence <https://example.com/licence>");
  });

  it("prints the dataset as JSON with --json, delegating to getDataset", async () => {
    const { library, io, out, calls } = harness();
    expect(await run(["show", "karate", "--json"], library, io)).toBe(EXIT_OK);
    expect(JSON.parse(out.stdout)).toEqual(JSON.parse(JSON.stringify(karate)));
    expect(calls).toEqual([["getDataset", "karate"]]);
  });

  it("turns an unknown id into exit status 2 with the library's message", async () => {
    const { library, io, out } = harness({
      getDataset: (id) => {
        throw new DatasetNotFoundError(id);
      },
    });
    expect(await run(["show", "missing"], library, io)).toBe(EXIT_FAILED);
    expect(out.stderr).toBe('no dataset "missing" in the catalogue\n');
  });
});

describe("fetch", () => {
  it("writes the result and its provenance, prints the counts and the warnings", async () => {
    const { library, io, out, calls } = harness();
    expect(await run(["fetch", "karate"], library, io)).toBe(EXIT_OK);
    expect(calls).toEqual([["fetchDataset", "karate"]]);
    expect(JSON.parse(out.files.get("karate.json") ?? "null")).toEqual(fetched.data);
    expect(JSON.parse(out.files.get("karate.provenance.json") ?? "null")).toEqual(fetched.provenance);
    expect(out.stdout).toBe("wrote karate.json (nodes 2, edges 1) and karate.provenance.json\n");
    expect(out.stderr).toBe("warning: nodes: the entry records 34, the fetched result has 2\n");
  });

  it("writes to --out, with provenance beside it", async () => {
    const { library, io, out } = harness();
    await run(["fetch", "karate", "--out", "data/club.json"], library, io);
    expect([...out.files.keys()]).toEqual(["data/club.json", "data/club.provenance.json"]);
    expect(provenancePath("graph")).toBe("graph.provenance.json");
  });

  it("turns a failing recipe into exit status 2 naming the entry and step", async () => {
    const { library, io, out } = harness({
      fetchDataset: async () => Promise.reject(new RecipeError("karate", "download", "https://example.org answered 404 Not Found")),
    });
    expect(await run(["fetch", "karate"], library, io)).toBe(EXIT_FAILED);
    expect(out.stderr).toBe("karate: download failed: https://example.org answered 404 Not Found\n");
    expect(out.files.size).toBe(0);
  });

  it("lets an error that is not the library's own propagate", async () => {
    const { library, io } = harness({ fetchDataset: async () => Promise.reject(new TypeError("a bug")) });
    await expect(run(["fetch", "karate"], library, io)).rejects.toThrow("a bug");
  });
});

describe("validate", () => {
  it("prints that a valid dataset is valid", async () => {
    const { library, io, out } = harness();
    expect(await run(["validate", "karate"], library, io)).toBe(EXIT_OK);
    expect(out.stdout).toBe("karate is valid\n");
  });

  it("prints every issue of an invalid one and exits 1", async () => {
    const { library, io, out } = harness({ validateDataset: () => [{ path: "crosswalk.rules.0", message: "a wildcard mismatch" }] });
    expect(await run(["validate", "karate"], library, io)).toBe(EXIT_NO);
    expect(out.stdout).toBe("crosswalk.rules.0: a wildcard mismatch\n");
  });
});

describe("roundtrip", () => {
  it("reports a round trip that holds", async () => {
    const { library, io, out, calls } = harness();
    expect(await run(["roundtrip", "karate"], library, io)).toBe(EXIT_OK);
    expect(calls).toEqual([["roundTripDataset", "karate"]]);
    expect(out.stdout).toBe("karate: the round trip holds\n");
  });

  it("reports where a round trip fails and exits 1", async () => {
    const { library, io, out } = harness({ roundTripDataset: async () => Promise.resolve({ holds: false, path: "", message: "records differ in keys", provenance: fetched.provenance }) });
    expect(await run(["roundtrip", "karate"], library, io)).toBe(EXIT_NO);
    expect(out.stdout).toBe("karate: the round trip does not hold at (root): records differ in keys\n");
  });
});
