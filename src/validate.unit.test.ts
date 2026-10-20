import { parseCrosswalk } from "crossmap";
import { describe, expect, it } from "vitest";
import { createCatalogue } from "./catalogue";
import { liveEntry, fixtureIndex, topologyCrosswalk } from "./test-support/entries";
import { validateDataset } from "./validate";

const dataset = createCatalogue(fixtureIndex).getDataset("karate");

describe("validateDataset", () => {
  it("finds nothing wrong with a dataset from a valid catalogue", () => {
    expect(validateDataset(dataset)).toEqual([]);
  });

  it("reports an entry that no longer matches the schema, by path", () => {
    expect(validateDataset({ ...dataset, entry: { ...dataset.entry, name: "" } })).toEqual([{ path: "entry.name", message: expect.any(String) as string }]);
  });

  it("reports a crosswalk that fails crossmap's structural validation or targets another category", () => {
    const duplicate = parseCrosswalk({ ...topologyCrosswalk, rules: [...liveEntry.crosswalk.rules, { op: "move", from: "extra", to: "meta" }] });
    expect(validateDataset({ ...dataset, crosswalk: duplicate })).toEqual([{ path: "crosswalk", message: "two rules write the same to path: meta" }]);
    const wildcardMismatch = parseCrosswalk({ ...topologyCrosswalk, rules: [{ op: "move", from: "nodes[].id", to: "ids" }] });
    expect(validateDataset({ ...dataset, crosswalk: wildcardMismatch }).map((issue) => issue.path)).toEqual(["crosswalk.rules.0"]);
    expect(validateDataset({ ...dataset, crosswalk: parseCrosswalk({ ...topologyCrosswalk, target: "graph/v2" }) }).map((issue) => issue.path)).toEqual(["crosswalk.target"]);
  });
});
