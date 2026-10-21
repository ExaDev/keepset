import { describe, expect, it } from "vitest";
import { NativeParseError } from "../errors";
import { parseNative, parseNativeFiles } from "./parse-native";

const ogb = { format: "ogb", encoding: "utf-8" } as const;

/** Files of an OGB raw directory, by path, as a files archive gives them (already gunzipped). */
const filesOf = (files: Readonly<Record<string, string>>): { path: string; bytes: Uint8Array }[] => Object.entries(files).map(([path, text]) => ({ path, bytes: new TextEncoder().encode(text) }));

function parseError(run: () => unknown): NativeParseError {
  try {
    run();
  } catch (error) {
    if (error instanceof NativeParseError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a NativeParseError");
}

/** The first edges of two ogbl-biokg relations, with the node-type header and counts of biokg/raw/num-node-dict.csv.gz, two lines of its triplet list and each relation's edge count cut down to the lines kept. The triplet list here lists the drug relation first, so the test sees the reader's sorted order. */
const BIOKG = {
  "biokg/raw/num-node-dict.csv.gz": "disease,protein,drug,sideeffect,function\n10687,17499,10533,9969,45085\n",
  "biokg/raw/triplet-type-list.csv.gz": "drug,drug-disease,disease\ndisease,disease-protein,protein\n",
  "biokg/raw/relations/drug___drug-disease___disease/edge.csv.gz": "1411,1402\n679,3573\n596,4350\n",
  "biokg/raw/relations/drug___drug-disease___disease/num-edge-list.csv.gz": "3\n",
  "biokg/raw/relations/disease___disease-protein___protein/edge.csv.gz": "1718,3207\n4903,13662\n",
  "biokg/raw/relations/disease___disease-protein___protein/num-edge-list.csv.gz": "2\n",
};

/** A homogeneous dataset in the layout of ogbl-citation2's raw directory (citation-v2/raw/), with a small node count. */
const CITATION = {
  "citation-v2/raw/num-node-list.csv.gz": "4\n",
  "citation-v2/raw/num-edge-list.csv.gz": "3\n",
  "citation-v2/raw/edge.csv.gz": "3,0\n3,1\n0,1\n",
};

/** How many nodes biokg's node-count header gives a type. */
function biokgCount(type: string): number {
  const [types = "", counts = ""] = BIOKG["biokg/raw/num-node-dict.csv.gz"].split("\n");

  return Number(counts.split(",")[types.split(",").indexOf(type)]);
}

describe("the ogb parser", () => {
  it("reads a heterogeneous dataset: typed nodes for every type in sorted order, isolated ones included, and each relation's edges with relations in sorted triplet order", () => {
    const graph = parseNativeFiles(filesOf(BIOKG), ogb);
    const sorted = ["disease", "drug", "function", "protein", "sideeffect"];
    expect(graph.nodes).toHaveLength(sorted.reduce((total, type) => total + biokgCount(type), 0));
    expect(graph.nodes.slice(0, 2)).toEqual([{ id: "disease:0" }, { id: "disease:1" }]);
    // Types sort as disease, drug, function, protein, sideeffect, whatever order the header gives them in.
    expect(graph.nodes[biokgCount("disease")]).toEqual({ id: "drug:0" });
    expect(graph.nodes[biokgCount("disease") + biokgCount("drug")]).toEqual({ id: "function:0" });
    expect(graph.nodes.at(-1)).toEqual({ id: `sideeffect:${String(biokgCount("sideeffect") - 1)}` });
    expect(graph.edges).toEqual([
      { source: "disease:1718", target: "protein:3207" },
      { source: "disease:4903", target: "protein:13662" },
      { source: "drug:1411", target: "disease:1402" },
      { source: "drug:679", target: "disease:3573" },
      { source: "drug:596", target: "disease:4350" },
    ]);
  });

  it("reads a homogeneous dataset: nodes 0 to N - 1, isolated ones included, and the edges in file order", () => {
    expect(parseNativeFiles(filesOf(CITATION), ogb)).toEqual({
      nodes: [{ id: "0" }, { id: "1" }, { id: "2" }, { id: "3" }],
      edges: [
        { source: "3", target: "0" },
        { source: "3", target: "1" },
        { source: "0", target: "1" },
      ],
    });
  });

  it("refuses an edge file whose line count differs from its recorded count", () => {
    const error = parseError(() => parseNativeFiles(filesOf({ ...CITATION, "citation-v2/raw/num-edge-list.csv.gz": "4\n" }), ogb));
    expect(error.message).toMatch(/holds 3 edges, but citation-v2\/raw\/num-edge-list\.csv\.gz records 4/);
  });

  it("refuses an index outside its node type's count, naming the line", () => {
    const error = parseError(() => parseNativeFiles(filesOf({ ...BIOKG, "biokg/raw/relations/drug___drug-disease___disease/edge.csv.gz": "1411,1402\n10533,0\n596,4350\n" }), ogb));
    expect(error.line).toBe(2);
    expect(error.message).toMatch(/drug___drug-disease___disease\/edge\.csv\.gz: edge 10533,0 names a node outside/);
    expect(() => parseNativeFiles(filesOf({ ...CITATION, "citation-v2/raw/edge.csv.gz": "3,0\n3,4\n0,1\n" }), ogb)).toThrow(/names a node outside the 4 sources/);
  });

  it("refuses a line that is not a pair of indices", () => {
    expect(parseError(() => parseNativeFiles(filesOf({ ...CITATION, "citation-v2/raw/edge.csv.gz": "3,0\n3,1,2\n0,1\n" }), ogb)).line).toBe(2);
    expect(() => parseNativeFiles(filesOf({ ...CITATION, "citation-v2/raw/edge.csv.gz": "3,0\n3,-1\n0,1\n" }), ogb)).toThrow(/expected a non-negative integer/);
  });

  it("refuses a relation directory the triplet list does not name, and a listed relation with no files", () => {
    expect(() => parseNativeFiles(filesOf({ ...BIOKG, "biokg/raw/triplet-type-list.csv.gz": "drug,drug-disease,disease\n" }), ogb)).toThrow(/raw\/relations\/disease___disease-protein___protein\/ is not one of the relations/);
    expect(() => parseNativeFiles(filesOf({ ...BIOKG, "biokg/raw/triplet-type-list.csv.gz": "drug,drug-disease,disease\ndisease,disease-protein,protein\ndrug,drug-protein,protein\n" }), ogb)).toThrow(/has no raw\/relations\/drug___drug-protein___protein\/edge\.csv\.gz/);
  });

  it("refuses a triplet naming a type the node counts do not count", () => {
    expect(() => parseNativeFiles(filesOf({ ...BIOKG, "biokg/raw/num-node-dict.csv.gz": "disease,protein\n10687,17499\n" }), ogb)).toThrow(/names a node type that .* does not count/);
  });

  it("refuses a dataset with both node-count files or neither, and one with several graphs", () => {
    expect(() => parseNativeFiles(filesOf({ ...CITATION, "citation-v2/raw/num-node-dict.csv.gz": "paper\n4\n" }), ogb)).toThrow(/exactly one of raw\/num-node-list\.csv\.gz/);
    expect(() => parseNativeFiles(filesOf({ "citation-v2/raw/edge.csv.gz": "0,1\n", "citation-v2/raw/num-edge-list.csv.gz": "1\n" }), ogb)).toThrow(/exactly one of raw\/num-node-list\.csv\.gz/);
    expect(() => parseNativeFiles(filesOf({ ...CITATION, "citation-v2/raw/num-node-list.csv.gz": "4\n5\n" }), ogb)).toThrow(/must hold one line, found 2/);
    expect(() => parseNativeFiles(filesOf({ ...BIOKG, "biokg/raw/num-node-dict.csv.gz": "disease,protein,drug,sideeffect,function\n1,1,1,1,1\n2,2,2,2,2\n" }), ogb)).toThrow(/a header of node types and one row of their counts, found 3 lines/);
  });

  it("refuses a file outside the raw layout, and files of two datasets", () => {
    expect(() => parseNativeFiles(filesOf({ ...CITATION, "citation-v2/raw/node-feat.csv.gz": "0.1,0.2\n" }), ogb)).toThrow(/citation-v2\/raw\/node-feat\.csv\.gz is not a file of an OGB raw directory/);
    expect(() => parseNativeFiles(filesOf({ ...CITATION, "other/raw/num-node-list.csv.gz": "4\n" }), ogb)).toThrow(/the raw files of one dataset, found the directories citation-v2\/, other\//);
  });

  it("refuses a homogeneous dataset's selection that also holds relations, and a heterogeneous one that also holds a top-level edge file", () => {
    expect(() => parseNativeFiles(filesOf({ ...CITATION, "citation-v2/raw/relations/a___r___a/edge.csv.gz": "0,1\n" }), ogb)).toThrow(/so it has one node type/);
    expect(() => parseNativeFiles(filesOf({ ...BIOKG, "biokg/raw/edge.csv.gz": "0,1\n" }), ogb)).toThrow(/so its edges are in raw\/relations\//);
  });

  it("is a parser of several files: one file alone is refused", () => {
    expect(() => parseNative(new TextEncoder().encode("0,1\n"), ogb)).toThrow(/reads the several files a files archive selects/);
  });
});
