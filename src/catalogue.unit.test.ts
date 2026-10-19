import { describe, expect, it } from "vitest";
import { getDataset, getManifest, listDatasets } from "./bundled";
import { CatalogueIndexSchema, createCatalogue } from "./catalogue";
import { CatalogueSyntaxError, DatasetAmbiguousError, DatasetNotFoundError } from "./errors";
import { deadEntry, fixtureIndex, liveEntry, representativeEntries, topologyCrosswalk } from "./test-support/entries";

const catalogue = createCatalogue(fixtureIndex);

describe("createCatalogue", () => {
  it("lists every dataset in entry id order when no filter is given", () => {
    expect(catalogue.listDatasets().map((dataset) => dataset.entry.id)).toEqual(["auth-walled", "celegans-metabolic", "karate"]);
  });

  it("filters by kind, category, domain and text, all of which must match", () => {
    expect(catalogue.listDatasets({ kind: "graph" })).toHaveLength(representativeEntries.length);
    expect(catalogue.listDatasets({ kind: "table" })).toEqual([]);
    expect(catalogue.listDatasets({ category: "graph/v1" })).toHaveLength(representativeEntries.length);
    expect(catalogue.listDatasets({ category: "graph/v2" })).toEqual([]);
    expect(catalogue.listDatasets({ domain: "Social network" }).map((dataset) => dataset.entry.id)).toEqual(["karate"]);
    expect(catalogue.listDatasets({ domain: "social network" })).toEqual([]);
    expect(catalogue.listDatasets({ text: "KARATE" }).map((dataset) => dataset.entry.id)).toEqual(["karate"]);
    expect(catalogue.listDatasets({ text: "small" }).map((dataset) => dataset.entry.id)).toEqual(["karate"]);
    expect(catalogue.listDatasets({ text: "elegans" }).map((dataset) => dataset.entry.id)).toEqual(["auth-walled", "celegans-metabolic"]);
    expect(catalogue.listDatasets({ text: "karate", domain: "Ecology" })).toEqual([]);
  });

  it("returns an entry's metadata, recipe and crosswalk, resolving a crosswalk file reference", () => {
    const dataset = catalogue.getDataset("celegans-metabolic");
    expect(dataset.entry).toEqual(deadEntry);
    expect(dataset.kind).toBe("graph");
    expect(dataset.crosswalk).toEqual(topologyCrosswalk);
    expect(dataset.catalogue).toEqual({ id: "fixture", version: "1.2.3" });
    expect(catalogue.getDataset("karate").crosswalk).toEqual(liveEntry.crosswalk);
  });

  it("throws DatasetNotFoundError for an unknown id, including a prototype name", () => {
    expect(() => catalogue.getDataset("missing")).toThrow(DatasetNotFoundError);
    expect(() => catalogue.getDataset("constructor")).toThrow(DatasetNotFoundError);
  });

  it("rejects duplicate entry ids", () => {
    expect(() => createCatalogue({ ...fixtureIndex, entries: [liveEntry, liveEntry] })).toThrow(CatalogueSyntaxError);
  });

  it("rejects a crosswalk file reference that does not resolve, including a prototype name", () => {
    expect(CatalogueIndexSchema.is({ ...fixtureIndex, crosswalks: {} })).toBe(false);
    expect(CatalogueIndexSchema.is({ ...fixtureIndex, entries: [{ ...deadEntry, crosswalk: { file: "constructor.json" } }] })).toBe(false);
  });

  it("rejects a crosswalk file whose target is not the entry's category", () => {
    expect(CatalogueIndexSchema.is({ ...fixtureIndex, crosswalks: { "crosswalks/graph-v1/topology.json": { ...topologyCrosswalk, target: "graph/v2" } } })).toBe(false);
  });

  it("rejects a crosswalk that fails twindex's structural validation", () => {
    const duplicateTarget = { ...topologyCrosswalk, rules: [...topologyCrosswalk.rules, { op: "move", from: "extra", to: "meta" }] };
    expect(CatalogueIndexSchema.is({ ...fixtureIndex, crosswalks: { "crosswalks/graph-v1/topology.json": duplicateTarget } })).toBe(false);
  });
});

/** Entries in two collections that share leaf names, so the short forms of a name can be ambiguous: `shared` is in `one/inner` and in `two`, and `lone` is only in `one/inner`. */
const inOne = { ...liveEntry, id: "one-shared", namespace: ["one", "inner"], aliases: ["shared"] };
const inTwo = { ...liveEntry, id: "two-shared", namespace: ["two"], aliases: ["shared"] };
const onlyInOne = { ...liveEntry, id: "one-lone", namespace: ["one", "inner"], aliases: ["lone"] };
const namespaced = createCatalogue({ ...fixtureIndex, entries: [inOne, inTwo, onlyInOne] });

describe("namespaces and aliases", () => {
  it("resolves an entry's own id", () => {
    expect(namespaced.getDataset("one-shared").entry.id).toBe("one-shared");
  });

  it("resolves an alias, and every qualified form of it, to the entry when the name is unambiguous", () => {
    for (const name of ["lone", "inner/lone", "one/inner/lone", "one-lone", "inner/one-lone", "one/inner/one-lone"]) {
      expect(namespaced.getDataset(name).entry.id).toBe("one-lone");
    }
  });

  it("resolves a name that is ambiguous at its short forms once it is qualified far enough", () => {
    expect(namespaced.getDataset("one/inner/shared").entry.id).toBe("one-shared");
    expect(namespaced.getDataset("inner/shared").entry.id).toBe("one-shared");
    expect(namespaced.getDataset("two/shared").entry.id).toBe("two-shared");
  });

  it("refuses an ambiguous name, naming the entries it could mean", () => {
    expect(() => namespaced.getDataset("shared")).toThrow(DatasetAmbiguousError);
    expect(() => namespaced.getDataset("shared")).toThrow(/one-shared, two-shared/);
    expect(() => namespaced.getDataset("shared")).toThrow(expect.objectContaining({ requested: "shared", candidateIds: ["one-shared", "two-shared"] }));
  });

  it("answers an entry's own id ahead of an alias or a short form that another entry also answers to", () => {
    const wins = createCatalogue({ ...fixtureIndex, entries: [{ ...liveEntry, id: "g53" }, { ...liveEntry, id: "ss-gset-g53", namespace: ["suitesparse", "gset"], aliases: ["g53"] }] });
    expect(wins.getDataset("g53").entry.id).toBe("g53");
    expect(wins.getDataset("gset/g53").entry.id).toBe("ss-gset-g53");
  });

  it("does not resolve a name that no entry answers to, including part of a path and a prototype name", () => {
    for (const name of ["inner", "one/inner", "one/shared", "nope/lone", "/lone", "lone/", "constructor", "__proto__"]) {
      expect(() => namespaced.getDataset(name)).toThrow(DatasetNotFoundError);
    }
  });

  it("filters by a namespace and everything beneath it, on whole segments", () => {
    const ids = (namespace: string): string[] => namespaced.listDatasets({ namespace }).map((dataset) => dataset.entry.id);
    expect(ids("one")).toEqual(["one-lone", "one-shared"]);
    expect(ids("one/inner")).toEqual(["one-lone", "one-shared"]);
    expect(ids("two")).toEqual(["two-shared"]);
    expect(ids("on")).toEqual([]);
    expect(ids("one/in")).toEqual([]);
  });

  it("finds an entry by an alias or its namespace in a text search", () => {
    expect(namespaced.listDatasets({ text: "lone" }).map((dataset) => dataset.entry.id)).toEqual(["one-lone"]);
    expect(namespaced.listDatasets({ text: "inner" }).map((dataset) => dataset.entry.id)).toEqual(["one-lone", "one-shared"]);
  });

  it("rejects two entries whose fully qualified names are the same", () => {
    const twin = { ...liveEntry, id: "twin", namespace: ["one", "inner"], aliases: ["lone"] };
    expect(CatalogueIndexSchema.is({ ...fixtureIndex, entries: [onlyInOne, twin] })).toBe(false);
  });

  it("rejects an alias that is another entry's id, which a lookup would reach instead", () => {
    expect(CatalogueIndexSchema.is({ ...fixtureIndex, entries: [liveEntry, { ...deadEntry, aliases: ["karate"] }] })).toBe(false);
  });

  it("accepts the same alias under different namespaces, and under none beside a namespaced entry's alias", () => {
    expect(CatalogueIndexSchema.is({ ...fixtureIndex, entries: [inOne, inTwo] })).toBe(true);
    expect(CatalogueIndexSchema.is({ ...fixtureIndex, entries: [inOne, { ...deadEntry, aliases: ["shared"] }] })).toBe(true);
  });
});

describe("the bundled catalogue", () => {
  it("is the keepset catalogue", () => {
    expect(getManifest()).toMatchObject({ id: "keepset", repository: "https://github.com/Mearman/keepset" });
  });

  it("answers listDatasets and getDataset consistently", () => {
    for (const dataset of listDatasets()) {
      expect(getDataset(dataset.entry.id)).toBe(dataset);
    }
    expect(() => getDataset("no-such-entry")).toThrow(DatasetNotFoundError);
  });
});
