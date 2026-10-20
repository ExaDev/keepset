import { describe, expect, it } from "vitest";
import { CategoryIdSchema, countTarget, getCategory, getCollectionTarget, getTarget, kindOf, listCategories } from "./categories";
import { KeepsetError, UnknownCategoryError } from "./errors";
import { GraphV1Schema } from "./targets/graph-v1";
import { OrV1Schema } from "./targets/or-v1";

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

  it("resolves or/v1 to its target schema", () => {
    expect(getTarget("or/v1")).toBe(OrV1Schema);
    expect(getCategory("or/v1").counted).toEqual(["nodes"]);
  });

  it("rejects an unknown category id with an error naming the known ones", () => {
    expect(() => getTarget("graph/v2")).toThrow(UnknownCategoryError);
    expect(() => getTarget("graph/v2")).toThrow(KeepsetError);
    expect(() => getTarget("graph/v2")).toThrow(/known categories are graph\/v1, or\/v1/);
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
    expect(kindOf("or/v1")).toBe("or");
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

  it("rejects a __proto__ metadata key rather than dropping it", () => {
    const meta: unknown = JSON.parse('{"__proto__": "x"}');
    expect(GraphV1Schema.is({ ...graph, meta })).toBe(false);
  });

  it("rejects a field beyond meta, nodes and edges at the top level", () => {
    expect(GraphV1Schema.is({ ...graph, extra: true })).toBe(false);
  });
});

const instance = {
  meta: { name: "Service requests", durationUnit: "seconds", note: null },
  nodes: [
    { id: "a", lat: 51.5, lon: -0.1, duration: 120, status: "Open", territory: "Camden", deadline: "2026-11-01" },
    { id: "b", lat: null, prize: 3, prizeProbability: 0.25, deadline: 1800, skill: "plumbing" },
    { id: "c", extraColumn: "kept as given" },
  ],
};

describe("the or/v1 target", () => {
  it("accepts a representative instance, with every field optional or null and others kept", () => {
    expect(OrV1Schema.parse(instance)).toEqual(instance);
  });

  it("rejects a node without an id and a duplicate id", () => {
    expect(OrV1Schema.is({ ...instance, nodes: [{ lat: 1 }] })).toBe(false);
    const result = OrV1Schema.safeParse({ ...instance, nodes: [{ id: "a" }, { id: "a" }] });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/duplicate node id/);
  });

  it("rejects values outside a field's range or kind", () => {
    for (const node of [{ lat: 91 }, { lat: -91 }, { lon: 181 }, { prizeProbability: 1.5 }, { prizeProbability: -0.1 }, { duration: -1 }, { travelTime: -1 }, { prize: "3" }, { skill: "" }, { deadline: true }]) {
      expect(OrV1Schema.is({ ...instance, nodes: [{ id: "a", ...node }] })).toBe(false);
    }
  });

  it("rejects an instance with arcs or any key beyond meta and nodes, and a non-scalar meta value", () => {
    expect(OrV1Schema.is({ ...instance, arcs: [] })).toBe(false);
    expect(OrV1Schema.is({ ...instance, meta: { nested: { a: 1 } } })).toBe(false);
  });

  it("counts its nodes", () => {
    expect(countTarget("or/v1", OrV1Schema.parse(instance))).toEqual(new Map([["nodes", instance.nodes.length]]));
  });
});

describe("a collection of any category", () => {
  const orSet = {
    meta: { name: "Route suite" },
    instances: [
      { id: "suite/a.txt", meta: { capacity: 200 }, nodes: [{ id: "1", x: 4, y: 5 }, { id: "2", prize: 3 }] },
      { id: "suite/b.txt", meta: {}, nodes: [{ id: "1", x: 0, y: 0 }] },
    ],
  };
  const graphSet = {
    meta: { name: "Graph suite" },
    instances: [
      { id: "g/a.edges", ...graph },
      { id: "g/b.edges", meta: {}, nodes: [{ id: "1" }], edges: [] },
    ],
  };

  it("is derived from each category's own document schema, so a category needs nothing of its own to be collected", () => {
    expect(getCollectionTarget("or/v1").safeParse(orSet).success).toBe(true);
    expect(getCollectionTarget("graph/v1").safeParse(graphSet).success).toBe(true);
    expect(getCollectionTarget("or/v1")).toBe(getCategory("or/v1").collection);
    expect(() => getCollectionTarget("or-set/v1")).toThrow(UnknownCategoryError);
  });

  it("keeps the instance's fields beside its id and counts instances, not nodes", () => {
    expect(getCollectionTarget("or/v1").parse(orSet)).toEqual(orSet);
    expect(countTarget("or/v1", getCollectionTarget("or/v1").parse(orSet))).toEqual(new Map([["instances", 2]]));
    expect(countTarget("graph/v1", getCollectionTarget("graph/v1").parse(graphSet))).toEqual(new Map([["instances", 2]]));
  });

  it("holds each instance to its category: an or/v1 node out of range and a graph edge to a missing node are refused, naming the instance", () => {
    const badNode = getCollectionTarget("or/v1").safeParse({ ...orSet, instances: [{ id: "x", meta: {}, nodes: [{ id: "1", lat: 91 }] }] });
    expect(badNode.success).toBe(false);
    expect(badNode.error?.issues.map((issue) => issue.path.join("."))).toEqual(["instances.0.nodes.0.lat"]);
    const badEdge = getCollectionTarget("graph/v1").safeParse({ ...graphSet, instances: [{ id: "x", meta: {}, nodes: [{ id: "1" }], edges: [{ source: "1", target: "9" }] }] });
    expect(badEdge.success).toBe(false);
    expect(badEdge.error?.issues.map((issue) => issue.path.join("."))).toEqual(["instances.0.edges.0.target"]);
  });

  it("allows node ids to repeat across instances but refuses them within one, and refuses a repeated instance id", () => {
    expect(getCollectionTarget("or/v1").safeParse(orSet).success).toBe(true);
    const within = getCollectionTarget("or/v1").safeParse({ ...orSet, instances: [{ id: "x", meta: {}, nodes: [{ id: "1" }, { id: "1" }] }] });
    expect(within.error?.issues.map((issue) => issue.path.join("."))).toEqual(["instances.0.nodes.1.id"]);
    const repeated = getCollectionTarget("or/v1").safeParse({ ...orSet, instances: [...orSet.instances, { id: "suite/a.txt", meta: {}, nodes: [] }] });
    expect(repeated.error?.issues.map((issue) => issue.path.join("."))).toEqual(["instances.2.id"]);
  });

  it("refuses an instance without a non-empty string id, one without its document's fields, and a key beyond meta and instances", () => {
    for (const bad of [{ meta: {}, nodes: [] }, { id: "", meta: {}, nodes: [] }, { id: 3, meta: {}, nodes: [] }, { id: "x" }]) {
      expect(getCollectionTarget("or/v1").safeParse({ ...orSet, instances: [bad] }).success).toBe(false);
    }
    expect(getCollectionTarget("or/v1").safeParse({ ...orSet, nodes: [] }).success).toBe(false);
    expect(getCollectionTarget("or/v1").safeParse({ instances: [] }).success).toBe(false);
  });
});
