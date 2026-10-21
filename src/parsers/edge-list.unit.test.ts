import { describe, expect, it } from "vitest";
import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import { parseEdgeList } from "./edge-list";

type EdgeListParser = Extract<Parser, { format: "edge-list" }>;

/** WormAtlas's NeuronConnect sheet as the xls reader writes it: Neuron 1, Neuron 2, the synapse type and the synapse count, the lines taken from the file as they stand (a gap junction is listed from each side, a chemical synapse once as a send from its presynaptic neuron and once as a receive from its postsynaptic one). */
const NEURON_CONNECT = ["Neuron 1,Neuron 2,Type,Nbr", "ADAR,ADAL,EJ,1", "AVDR,ADAL,EJ,2", "ADEL,ADAL,Sp,1", "AIBR,ADAL,Rp,2", "BDUL,ADEL,S,3", "ADAL,ADAR,EJ,1", "ADAL,AIBR,Sp,2", "ADAL,AVDR,EJ,2", "AS02,NMJ,NMJ,11"].join("\n");
const COLUMN = { from: 0, to: 1, type: 2, count: 3 } as const;
const SENDS = ["S", "Sp"];
const EXPECTED = { synapsesFromBdul: 3, synapsesFromAdal: 2 } as const;

const parser = (options: Partial<EdgeListParser> = {}): EdgeListParser => ({ format: "edge-list", encoding: "utf-8", delimiter: "comma", skipLines: 1, commentPrefixes: [], sourceColumn: COLUMN.from, targetColumn: COLUMN.to, ...options });

describe("parseEdgeList on a table of several relations", () => {
  it("keeps only the lines whose type column names a kept relation", () => {
    const graph = parseEdgeList(NEURON_CONNECT, parser({ keep: { column: COLUMN.type, values: SENDS } }));
    expect(graph.edges).toEqual([
      { source: "ADEL", target: "ADAL" },
      { source: "BDUL", target: "ADEL" },
      { source: "ADAL", target: "AIBR" },
    ]);
    expect(graph.nodes.map((node) => node.id)).toEqual(["ADEL", "ADAL", "BDUL", "AIBR"]);
  });

  it("emits as many edges for a line as its multiplicity column says", () => {
    const graph = parseEdgeList(NEURON_CONNECT, parser({ keep: { column: COLUMN.type, values: SENDS }, multiplicityColumn: COLUMN.count }));
    expect(graph.edges.filter((edge) => edge.source === "BDUL")).toHaveLength(EXPECTED.synapsesFromBdul);
    expect(graph.edges.filter((edge) => edge.source === "ADAL")).toHaveLength(EXPECTED.synapsesFromAdal);
    expect(graph.edges).toHaveLength(1 + EXPECTED.synapsesFromBdul + EXPECTED.synapsesFromAdal);
  });

  it("emits each pair of a mirrored table once, in the direction it is first listed, keeping self-loops", () => {
    const table = `${NEURON_CONNECT}\nRMEL,RMEL,EJ,1`;
    const graph = parseEdgeList(table, parser({ keep: { column: COLUMN.type, values: ["EJ"] }, mirrored: true }));
    expect(graph.edges).toEqual([
      { source: "ADAR", target: "ADAL" },
      { source: "AVDR", target: "ADAL" },
      { source: "RMEL", target: "RMEL" },
    ]);
  });

  it("reads a line whose count is zero as no edge, adding none of its neurons", () => {
    const graph = parseEdgeList("h\nAVFL,VB01,Sp,0\nFLPR,VB01,Sp,1", parser({ multiplicityColumn: COLUMN.count }));
    expect(graph).toEqual({ nodes: [{ id: "FLPR" }, { id: "VB01" }], edges: [{ source: "FLPR", target: "VB01" }] });
  });

  it("refuses a mirrored line without its mirror, one whose mirror has another count, and a count that is not a whole number", () => {
    const options = parser({ keep: { column: COLUMN.type, values: ["EJ"] }, mirrored: true });
    expect(() => parseEdgeList("h\nADAR,ADAL,EJ,1", options)).toThrow(/line 2: the table is mirrored but this line has no mirror image/);
    expect(() => parseEdgeList("h\nADAR,ADAL,EJ,1\nADAL,ADAR,EJ,2", { ...options, multiplicityColumn: COLUMN.count })).toThrow(NativeParseError);
    expect(() => parseEdgeList("h\nADAR,ADAL,EJ,1.5", parser({ multiplicityColumn: COLUMN.count }))).toThrow(/not a whole number/);
    expect(() => parseEdgeList("h\nADAR,ADAL,EJ,-1", parser({ multiplicityColumn: COLUMN.count }))).toThrow(/not a whole number/);
  });
});
