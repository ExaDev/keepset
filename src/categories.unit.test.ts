import { describe, expect, it } from "vitest";
import { CategoryIdSchema, countTarget, getCategory, getTarget, kindOf, listCategories } from "./categories";
import { KeepsetError, UnknownCategoryError } from "./errors";
import { GraphV1Schema } from "./targets/graph-v1";
import { OrSetV1Schema } from "./targets/or-set-v1";
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
    expect(() => getTarget("graph/v2")).toThrow(/known categories are graph\/v1, or\/v1, or-set\/v1/);
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
    expect(kindOf("or-set/v1")).toBe("or-set");
  });

  it("resolves or-set/v1 to its target schema, a collection that counts its instances", () => {
    expect(getTarget("or-set/v1")).toBe(OrSetV1Schema);
    expect(getCategory("or-set/v1")).toMatchObject({ shape: "collection", counted: ["instances"] });
    expect(listCategories().filter((category) => category.shape === "collection").map((category) => category.id)).toEqual(["or-set/v1"]);
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

describe("the or-set/v1 target", () => {
  const set = {
    meta: { name: "Route suite" },
    instances: [
      { id: "suite/a.txt", meta: { capacity: 200 }, nodes: [{ id: "1", x: 4, y: 5 }, { id: "2", prize: 3 }] },
      { id: "suite/b.txt", meta: {}, nodes: [{ id: "1", x: 0, y: 0 }] },
    ],
  };

  it("accepts a set of instances, each numbering its own nodes", () => {
    expect(OrSetV1Schema.parse(set)).toEqual(set);
  });

  it("counts instances, not nodes", () => {
    expect(countTarget("or-set/v1", OrSetV1Schema.parse(set))).toEqual(new Map([["instances", 2]]));
  });

  it("rejects a duplicate instance id, naming the instance", () => {
    const result = OrSetV1Schema.safeParse({ ...set, instances: [...set.instances, { id: "suite/a.txt", meta: {}, nodes: [] }] });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([["instances", 2, "id"]]);
  });

  it("rejects a duplicate node id within one instance, naming the instance and the node", () => {
    const result = OrSetV1Schema.safeParse({ ...set, instances: [{ id: "x", meta: {}, nodes: [{ id: "1" }, { id: "1" }] }] });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([["instances", 0, "nodes", 1, "id"]]);
  });

  it("rejects a node field outside the or/v1 node's range, and an instance without its id, meta or nodes", () => {
    expect(OrSetV1Schema.is({ ...set, instances: [{ id: "x", meta: {}, nodes: [{ id: "1", lat: 91 }] }] })).toBe(false);
    for (const missing of ["id", "meta", "nodes"]) {
      const rest = Object.fromEntries(Object.entries({ id: "x", meta: {}, nodes: [] }).filter(([key]) => key !== missing));
      expect(OrSetV1Schema.is({ ...set, instances: [rest] })).toBe(false);
    }
  });

  it("rejects a key beyond meta and instances", () => {
    expect(OrSetV1Schema.is({ ...set, nodes: [] })).toBe(false);
  });
});
