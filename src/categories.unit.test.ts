import { describe, expect, it } from "vitest";
import { CategoryIdSchema, getCategory, getTarget, kindOf, listCategories } from "./categories";
import { KeepsetError, UnknownCategoryError } from "./errors";
import { GraphV1Schema } from "./targets/graph-v1";

const graph = {
  meta: { name: "Zachary karate club", directed: false, nodeCount: 3, note: null },
  nodes: [{ id: "1", type: "member" }, { id: "2" }, { id: "3", label: "kept as given" }],
  edges: [
    { source: "1", target: "2", type: "friendship" },
    { source: "2", target: "3", weight: 4 },
  ],
};

describe("the category registry", () => {
  it("resolves graph/v1 to its target schema", () => {
    expect(getTarget("graph/v1")).toBe(GraphV1Schema);
    expect(getCategory("graph/v1").id).toBe("graph/v1");
  });

  it("rejects an unknown category id with an error naming the known ones", () => {
    expect(() => getTarget("graph/v2")).toThrow(UnknownCategoryError);
    expect(() => getTarget("graph/v2")).toThrow(KeepsetError);
    expect(() => getTarget("graph/v2")).toThrow(/known categories are graph\/v1/);
  });

  it("does not resolve names inherited from Object.prototype", () => {
    expect(() => getTarget("constructor")).toThrow(UnknownCategoryError);
    expect(() => getTarget("__proto__")).toThrow(UnknownCategoryError);
  });

  it("keys every category by its own id, in the kind/version form", () => {
    for (const category of listCategories()) {
      expect(CategoryIdSchema.parse(category.id)).toBe(category.id);
      expect(category.id).toMatch(/^[a-z][a-z0-9-]*\/v[1-9]\d*$/);
    }
    expect(listCategories().map((category) => category.id)).toEqual(CategoryIdSchema.options);
  });

  it("derives the kind of data from the id", () => {
    expect(kindOf("graph/v1")).toBe("graph");
  });
});

describe("the graph/v1 target", () => {
  it("accepts a representative graph, keeping fields beyond the target", () => {
    expect(GraphV1Schema.parse(graph)).toEqual(graph);
  });

  it("rejects a node without an id", () => {
    expect(GraphV1Schema.is({ ...graph, nodes: [...graph.nodes, { type: "member" }] })).toBe(false);
  });

  it("rejects an edge without a source or a target", () => {
    expect(GraphV1Schema.is({ ...graph, edges: [{ target: "1" }] })).toBe(false);
    expect(GraphV1Schema.is({ ...graph, edges: [{ source: "1" }] })).toBe(false);
  });

  it("rejects an edge whose endpoint names no node", () => {
    const result = GraphV1Schema.safeParse({ ...graph, edges: [{ source: "1", target: "9" }] });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([["edges", 0, "target"]]);
  });

  it("rejects duplicate node ids", () => {
    expect(GraphV1Schema.is({ ...graph, nodes: [...graph.nodes, { id: "1" }] })).toBe(false);
  });

  it("rejects metadata that is not a flat record of scalars", () => {
    expect(GraphV1Schema.is({ ...graph, meta: { nested: { a: 1 } } })).toBe(false);
    expect(GraphV1Schema.is({ ...graph, meta: { count: Number.POSITIVE_INFINITY } })).toBe(false);
  });

  it("rejects a field beyond meta, nodes and edges at the top level", () => {
    expect(GraphV1Schema.is({ ...graph, extra: true })).toBe(false);
  });
});
