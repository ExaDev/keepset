import { describe, expect, it } from "vitest";
import { getDataset, getManifest, listDatasets } from "./bundled";
import { CatalogueIndexSchema, createCatalogue } from "./catalogue";
import { CatalogueSyntaxError, DatasetNotFoundError } from "./errors";
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

describe("the bundled catalogue", () => {
  it("is the keepset catalogue", () => {
    expect(getManifest()).toMatchObject({ id: "keepset", repository: "https://github.com/ExaDev/keepset" });
  });

  it("answers listDatasets and getDataset consistently", () => {
    for (const dataset of listDatasets()) {
      expect(getDataset(dataset.entry.id)).toBe(dataset);
    }
    expect(() => getDataset("no-such-entry")).toThrow(DatasetNotFoundError);
  });
});
