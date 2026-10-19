import { describe, expect, it } from "vitest";
import { EntrySchema, parseEntry, SourceSchema, waybackUrl } from "./entry";
import { CatalogueSyntaxError } from "./errors";
import { serialise } from "./serialise";
import { deadEntry, liveEntry, representativeEntries } from "./test-support/entries";

const requiredFields = ["id", "name", "tags", "category", "sources", "licence", "citations", "recipe", "crosswalk", "expectedCounts", "properties"] as const;

function without(doc: Readonly<Record<string, unknown>>, field: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(doc).filter(([key]) => key !== field));
}

describe("the entry format", () => {
  it("round-trips representative entries through parse and serialise", () => {
    for (const doc of representativeEntries) {
      const text = serialise(parseEntry(doc));
      const parsed = parseEntry(JSON.parse(text));
      expect(parsed).toEqual(doc);
      expect(serialise(parsed)).toBe(text);
      expect(EntrySchema.is(doc)).toBe(true);
    }
  });

  it.each(requiredFields)("rejects an entry missing %s", (field) => {
    expect(() => parseEntry(without(liveEntry, field))).toThrow(CatalogueSyntaxError);
  });

  it("accepts an entry without the optional description and domain", () => {
    expect(EntrySchema.is(without(without(liveEntry, "description"), "domain"))).toBe(true);
  });

  it("rejects an entry whose category names no known category, at the category path", () => {
    let caught: unknown;
    try {
      parseEntry({ ...liveEntry, category: "graph/v9" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CatalogueSyntaxError);
    expect(caught instanceof CatalogueSyntaxError ? caught.issues.map((issue) => issue.path) : []).toContain("category");
  });

  it("rejects an inline crosswalk whose target is not the entry's category", () => {
    expect(EntrySchema.is({ ...liveEntry, crosswalk: { ...liveEntry.crosswalk, target: "graph/v2" } })).toBe(false);
  });

  it("rejects a recipe naming a source the entry does not have", () => {
    expect(EntrySchema.is({ ...liveEntry, recipe: { ...liveEntry.recipe, source: 1 } })).toBe(false);
  });

  it("rejects an edge-list parser whose source and target columns coincide", () => {
    expect(EntrySchema.is({ ...liveEntry, recipe: { ...liveEntry.recipe, parser: { ...liveEntry.recipe.parser, targetColumn: 0 } } })).toBe(false);
  });

  it("rejects archive member and crosswalk paths that climb out of their directory", () => {
    expect(EntrySchema.is({ ...deadEntry, recipe: { ...deadEntry.recipe, archive: { kind: "zip", member: { path: "../outside.net" } } } })).toBe(false);
    expect(EntrySchema.is({ ...deadEntry, crosswalk: { file: "/etc/crosswalk.json" } })).toBe(false);
  });

  it("rejects record keys Object.prototype would react to", () => {
    const properties: unknown = JSON.parse('{"__proto__": 1}');
    expect(EntrySchema.is({ ...liveEntry, properties })).toBe(false);
    expect(EntrySchema.is({ ...liveEntry, properties: { constructor: 1 } })).toBe(true);
  });

  it("rejects expected counts for a collection the category does not count", () => {
    expect(EntrySchema.is({ ...liveEntry, expectedCounts: { meta: 1 } })).toBe(false);
    expect(EntrySchema.is({ ...liveEntry, expectedCounts: { constructor: 1 } })).toBe(false);
  });

  it("rejects properties that would overwrite the id or name a fetched result's meta takes from the entry", () => {
    expect(EntrySchema.is({ ...liveEntry, properties: { id: "other" } })).toBe(false);
    expect(EntrySchema.is({ ...liveEntry, properties: { name: "other" } })).toBe(false);
  });

  it("accepts an http URL on an address or a single-label host", () => {
    expect(EntrySchema.is({ ...liveEntry, sources: [{ ...liveEntry.sources[0], url: "http://127.0.0.1:8080/net.txt" }] })).toBe(true);
    expect(EntrySchema.is({ ...liveEntry, sources: [{ ...liveEntry.sources[0], url: "http://datastore/net.txt" }] })).toBe(true);
  });

  it("rejects a download URL that is not http or https", () => {
    expect(EntrySchema.is({ ...liveEntry, sources: [{ ...liveEntry.sources[0], url: "file:///scratch/cache.zip" }] })).toBe(false);
  });
});

describe("a source's snapshot", () => {
  const url = "http://example.edu/data/net.zip";

  it("is required when the source is dead", () => {
    expect(SourceSchema.safeParse({ url, retrieved: "2026-04-19", status: "dead" }).success).toBe(false);
  });

  it("may pin a live source", () => {
    expect(SourceSchema.safeParse({ url, retrieved: "2026-04-19", status: "live", snapshot: { url: waybackUrl("20061110114126", url), timestamp: "20061110114126" } }).success).toBe(true);
  });

  it("must be the Wayback URL of this source at its own timestamp", () => {
    expect(SourceSchema.safeParse({ url, retrieved: "2026-04-19", status: "dead", snapshot: { url: waybackUrl("20230601", url), timestamp: "20230602" } }).success).toBe(false);
    expect(SourceSchema.safeParse({ url, retrieved: "2026-04-19", status: "dead", snapshot: { url: waybackUrl("20230601", "http://example.edu/other.zip"), timestamp: "20230601" } }).success).toBe(false);
  });

  it("rejects a timestamp that is not a Wayback timestamp", () => {
    expect(SourceSchema.safeParse({ url, retrieved: "2026-04-19", status: "dead", snapshot: { url: waybackUrl("2023-06-01", url), timestamp: "2023-06-01" } }).success).toBe(false);
  });
});

describe("an entry's namespace and aliases", () => {
  it("accepts a namespace and aliases, and round-trips them through parse and serialise", () => {
    const doc = { ...liveEntry, namespace: ["suitesparse", "gset"], aliases: ["g53"] };
    expect(parseEntry(JSON.parse(serialise(parseEntry(doc))))).toEqual(parseEntry(doc));
  });

  it("refuses a namespace segment or an alias that is not an id, so none can contain the separator", () => {
    for (const bad of ["a/b", "", "_x", "has space"]) {
      expect(EntrySchema.is({ ...liveEntry, namespace: [bad] })).toBe(false);
      expect(EntrySchema.is({ ...liveEntry, aliases: [bad] })).toBe(false);
    }
  });

  it("refuses an empty namespace and an empty alias list, so absence has one form", () => {
    expect(EntrySchema.is({ ...liveEntry, namespace: [] })).toBe(false);
    expect(EntrySchema.is({ ...liveEntry, aliases: [] })).toBe(false);
  });

  it("refuses a repeated alias and an alias equal to the entry's own id", () => {
    expect(EntrySchema.is({ ...liveEntry, aliases: ["short", "short"] })).toBe(false);
    expect(EntrySchema.is({ ...liveEntry, aliases: [liveEntry.id] })).toBe(false);
  });
});
