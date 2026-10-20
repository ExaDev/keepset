import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { waybackUrl } from "../../src/entry";
import { serialise } from "../../src/serialise";
import { groupSources, loadEntryFiles, pinSnapshots, recordSnapshots, snapshotOf } from "./entries";
import { entryWith, liveSource } from "./test-support";

const directories: string[] = [];
afterAll(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "keepset-sources-"));
  directories.push(directory);

  return directory;
}

const deadSource = (url: string, timestamp: string): unknown => ({ url, retrieved: "2026-10-01", status: "dead", snapshot: snapshotOf(timestamp, url) });

describe("snapshotOf", () => {
  it("spells the URL exactly as the entry schema requires", () => {
    expect(snapshotOf("20260101000000", "https://example.org/a")).toEqual({ timestamp: "20260101000000", url: waybackUrl("20260101000000", "https://example.org/a") });
  });
});

describe("pinSnapshots", () => {
  it("pins the snapshot on a source without one and changes nothing else about the entry", () => {
    const entry = entryWith("one", [liveSource("https://example.org/a"), liveSource("https://example.org/b")]);
    const pinned = pinSnapshots(entry, new Map([["https://example.org/a", "20260102030405"]]));
    expect(pinned.sources[0]?.snapshot).toEqual(snapshotOf("20260102030405", "https://example.org/a"));
    expect(pinned.sources[1]).toEqual(entry.sources[1]);
    expect({ ...pinned, sources: undefined }).toEqual({ ...entry, sources: undefined });
    expect(pinned.sources[0]).toMatchObject({ url: "https://example.org/a", retrieved: "2026-10-01", status: "live" });
  });

  it("never replaces a snapshot a source already pins", () => {
    const entry = entryWith("one", [deadSource("https://example.org/a", "20200101000000")]);
    const pinned = pinSnapshots(entry, new Map([["https://example.org/a", "20260102030405"]]));
    expect(pinned).toBe(entry);
    expect(pinned.sources[0]?.snapshot?.timestamp).toBe("20200101000000");
  });

  it("returns the same entry when no URL matches", () => {
    const entry = entryWith("one", [liveSource("https://example.org/a")]);
    expect(pinSnapshots(entry, new Map([["https://example.org/other", "20260102030405"]]))).toBe(entry);
  });
});

describe("loadEntryFiles", () => {
  it("reads the entries of a directory in file order", () => {
    const directory = scratch();
    for (const id of ["b", "a"]) {
      writeFileSync(join(directory, `${id}.json`), serialise(entryWith(id, [liveSource(`https://example.org/${id}`)])));
    }
    expect(loadEntryFiles(directory).map((file) => file.entry.id)).toEqual(["a", "b"]);
  });

  it("refuses a file that is not in canonical form, so an edit could not stay confined to the snapshot", () => {
    const directory = scratch();
    writeFileSync(join(directory, "a.json"), JSON.stringify(entryWith("a", [liveSource("https://example.org/a")])));
    expect(() => loadEntryFiles(directory)).toThrow("not in canonical form");
  });
});

describe("recordSnapshots", () => {
  it("rewrites only the files that gain a snapshot, byte for byte otherwise the same", () => {
    const directory = scratch();
    const target = entryWith("a", [liveSource("https://example.org/a")]);
    const bystander = entryWith("b", [liveSource("https://example.org/b")]);
    writeFileSync(join(directory, "a.json"), serialise(target));
    writeFileSync(join(directory, "b.json"), serialise(bystander));
    const { files, written } = recordSnapshots(loadEntryFiles(directory), new Map([["https://example.org/a", "20260102030405"]]));
    expect(written).toBe(1);
    expect(readFileSync(join(directory, "b.json"), "utf8")).toBe(serialise(bystander));
    const after = readFileSync(join(directory, "a.json"), "utf8");
    expect(after).toBe(serialise(pinSnapshots(target, new Map([["https://example.org/a", "20260102030405"]]))));
    expect(files[0]?.entry.sources[0]?.snapshot?.timestamp).toBe("20260102030405");
    // The edited file is canonical, so the next run can read it.
    expect(loadEntryFiles(directory)[0]?.entry.sources[0]?.snapshot?.timestamp).toBe("20260102030405");
  });
});

describe("groupSources", () => {
  const files = [
    { path: "a", entry: entryWith("a", [liveSource("https://example.org/shared"), deadSource("https://example.org/gone", "20200101000000")]) },
    { path: "b", entry: entryWith("b", [{ ...liveSource("https://example.org/shared"), snapshot: snapshotOf("20250101000000", "https://example.org/shared") }]) },
    { path: "c", entry: entryWith("c", [liveSource("https://example.org/paged"), liveSource("https://example.org/landing")], { recipe: { status: "fetchable", source: 0, paging: { kind: "socrata-resource", pageSize: 100 }, archive: { kind: "none" }, parser: { format: "csv-table", encoding: "utf-8", delimiter: "comma", skipLines: 0, idColumn: null, numericColumns: [] } } }) },
  ];
  const groups = groupSources(files);
  const group = (url: string): (typeof groups)[number] => {
    const found = groups.find((candidate) => candidate.url === url);
    if (found === undefined) {
      throw new Error(`no group for ${url}`);
    }

    return found;
  };

  it("lists each URL once, sorted, with every entry that records it", () => {
    expect(groups.map((entry) => entry.url)).toEqual(["https://example.org/gone", "https://example.org/landing", "https://example.org/paged", "https://example.org/shared"]);
    expect(group("https://example.org/shared").entryIds).toEqual(["a", "b"]);
  });

  it("takes the latest snapshot any entry pins and notes that another entry lacks it", () => {
    expect(group("https://example.org/shared")).toMatchObject({ snapshot: { timestamp: "20250101000000" }, unpinned: true, live: true });
    expect(group("https://example.org/gone")).toMatchObject({ snapshot: { timestamp: "20200101000000" }, unpinned: false, live: false });
  });

  it("marks only the URL a recipe pages through as paged", () => {
    expect(group("https://example.org/paged").paged).toBe(true);
    expect(group("https://example.org/landing").paged).toBe(false);
  });
});
