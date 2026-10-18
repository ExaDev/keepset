import { describe, expect, it } from "vitest";
import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import { parseNative } from "./parse-native";

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** One byte per character, for files whose bytes are not utf-8: each character's code point below 256 is the byte. */
const bytesOf = (text: string): Uint8Array => Uint8Array.from(text, (char) => char.charCodeAt(0));

const edgeList = (options: Partial<Extract<Parser, { format: "edge-list" }>> = {}): Parser => ({
  format: "edge-list",
  encoding: "utf-8",
  delimiter: "whitespace",
  skipLines: 0,
  commentPrefixes: ["#", "%"],
  sourceColumn: 0,
  targetColumn: 1,
  ...options,
});

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

describe("the edge-list parser", () => {
  it("reads edges in file order and nodes in first-appearance order, skipping comments and blank lines", () => {
    const text = "# a comment\n% another\n\n2 1\r\n1\t3 0.5\n  # indented comment\n3 2\n";
    expect(parseNative(utf8(text), edgeList())).toEqual({
      nodes: [{ id: "2" }, { id: "1" }, { id: "3" }],
      edges: [
        { source: "2", target: "1" },
        { source: "1", target: "3" },
        { source: "3", target: "2" },
      ],
    });
  });

  it("honours the delimiter, header lines and column order", () => {
    const text = "count\n# source, target\na,b,9\nb,c,9\n";
    expect(parseNative(utf8(text), edgeList({ delimiter: "comma", skipLines: 1, sourceColumn: 1, targetColumn: 0 })).edges).toEqual([
      { source: "b", target: "a" },
      { source: "c", target: "b" },
    ]);
    expect(parseNative(utf8("x y\tz\n"), edgeList({ delimiter: "tab" })).edges).toEqual([{ source: "x y", target: "z" }]);
    expect(parseNative(utf8("x  y\n"), edgeList({ delimiter: "space", targetColumn: 2 })).edges).toEqual([{ source: "x", target: "y" }]);
  });

  it("names the line of a row with too few fields or an empty endpoint", () => {
    expect(parseError(() => parseNative(utf8("1 2\n3\n"), edgeList())).line).toBe(2);
    expect(parseError(() => parseNative(utf8("1,2\n,4\n"), edgeList({ delimiter: "comma" }))).line).toBe(2);
  });

  it("rejects a file with no edges", () => {
    expect(() => parseNative(utf8("# only comments\n"), edgeList())).toThrow(NativeParseError);
  });
});

describe("the Matrix Market parser", () => {
  const mm = (header: string, body: string): Uint8Array => utf8(`%%MatrixMarket matrix coordinate ${header}\n% comment\n${body}`);

  it("reads a square matrix as nodes 1 to n with one edge per stored entry, isolated nodes included", () => {
    expect(parseNative(mm("pattern symmetric", "4 4 2\n2 1\n3 2\n"), { format: "matrix-market", encoding: "utf-8" })).toEqual({
      nodes: [{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }],
      edges: [
        { source: "2", target: "1" },
        { source: "3", target: "2" },
      ],
    });
  });

  it("reads a rectangular matrix as a bipartite graph of row and column nodes", () => {
    expect(parseNative(mm("real general", "2 3 2\n1 3 0.5\n2 1 -1\n"), { format: "matrix-market", encoding: "utf-8" })).toEqual({
      nodes: [{ id: "r1" }, { id: "r2" }, { id: "c1" }, { id: "c2" }, { id: "c3" }],
      edges: [
        { source: "r1", target: "c3" },
        { source: "r2", target: "c1" },
      ],
    });
  });

  it("rejects the array layout, an unknown field, a wrong token count, an out-of-range entry and a short file", () => {
    const parser: Parser = { format: "matrix-market", encoding: "utf-8" };
    // mm() writes the header, a comment and the size line, so the first entry is line 4.
    const firstEntryLine = 4;
    expect(parseError(() => parseNative(utf8("%%MatrixMarket matrix array real general\n2 2\n1\n2\n3\n4\n"), parser)).line).toBe(1);
    expect(parseError(() => parseNative(mm("quaternion general", "1 1 1\n1 1 1\n"), parser)).line).toBe(1);
    expect(parseError(() => parseNative(mm("real general", "2 2 1\n1 2\n"), parser)).line).toBe(firstEntryLine);
    expect(parseError(() => parseNative(mm("pattern general", "2 2 1\n3 1\n"), parser)).line).toBe(firstEntryLine);
    expect(() => parseNative(mm("pattern general", "2 2 2\n1 2\n"), parser)).toThrow(/declares 2 entries but the file holds 1/);
    expect(() => parseNative(utf8("1 2\n"), parser)).toThrow(/MatrixMarket/);
  });
});

describe("the GML parser", () => {
  const gml: Parser = { format: "gml", encoding: "utf-8" };

  it("reads nodes by id and edges by source and target, ignoring other keys and comments", () => {
    const text = `Creator "a test"
# a comment line
graph [
  directed 0
  node [ id 0 label "zero [not a bracket]" value 1 graphics [ x 1.5 y -2e3 ] ]
  node [ id 1 label "one
spans lines" ]
  edge [ source 1 target 0 value 2.5 ]
]`;
    expect(parseNative(utf8(text), gml)).toEqual({ nodes: [{ id: "0" }, { id: "1" }], edges: [{ source: "1", target: "0" }] });
  });

  it("rejects a node without exactly one id, an edge without a target, an unclosed list and a second graph", () => {
    expect(() => parseNative(utf8("graph [ node [ label \"x\" ] ]"), gml)).toThrow(/exactly one scalar id/);
    expect(() => parseNative(utf8("graph [ node [ id 1 id 2 ] ]"), gml)).toThrow(/exactly one scalar id/);
    expect(() => parseNative(utf8("graph [ edge [ source 1 ] ]"), gml)).toThrow(/exactly one scalar target/);
    expect(parseError(() => parseNative(utf8("graph [\n node [ id 1 ]\n"), gml)).line).toBe(2);
    expect(() => parseNative(utf8("graph [ ] graph [ ]"), gml)).toThrow(/exactly one graph/);
    expect(() => parseNative(utf8('graph [ node [ id "1 ] ]'), gml)).toThrow(/never closed/);
  });
});

describe("the Pajek parser", () => {
  const pajek: Parser = { format: "pajek", encoding: "utf-8" };

  it("reads vertices 1 to n, arcs, edges and adjacency lists, skipping labels and weights", () => {
    const text = `*Network demo
*Vertices 4
1 "one" 0.1 0.2
2 "two"
*Arcs
1 2 3.5
*Edges :2 "friends"
2 3
*Arcslist
3 1 2
`;
    expect(parseNative(utf8(text), pajek)).toEqual({
      nodes: [{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }],
      edges: [
        { source: "1", target: "2" },
        { source: "2", target: "3" },
        { source: "3", target: "1" },
        { source: "3", target: "2" },
      ],
    });
  });

  it("reads a two-mode matrix with rows as the first mode and columns as the second", () => {
    const text = "*Vertices 4 2\n*Matrix\n1 0\n0 2\n";
    expect(parseNative(utf8(text), pajek).edges).toEqual([
      { source: "1", target: "3" },
      { source: "2", target: "4" },
    ]);
  });

  it("skips partitions and vectors, including their own *Vertices lines", () => {
    const text = "*Vertices 2\n*Edges\n1 2\n*Partition groups\n*Vertices 2\n1\n2\n";
    expect(parseNative(utf8(text), pajek).edges).toEqual([{ source: "1", target: "2" }]);
  });

  it("rejects an out-of-range vertex, data before *Vertices, a second network and a malformed matrix row", () => {
    const arcLine = 3;
    expect(parseError(() => parseNative(utf8("*Vertices 2\n*Arcs\n1 3\n"), pajek)).line).toBe(arcLine);
    expect(() => parseNative(utf8("*Arcs\n1 2\n"), pajek)).toThrow(/before \*Vertices/);
    expect(() => parseNative(utf8("*Network a\n*Vertices 1\n*Network b\n"), pajek)).toThrow(/more than one network/);
    expect(() => parseNative(utf8("*Vertices 2\n*Matrix\n1 0 1\n"), pajek)).toThrow(/matrix rows/);
    expect(() => parseNative(utf8("*Vertices 2\n*Unknown\n"), pajek)).toThrow(/unknown section/);
  });
});

describe("decoding", () => {
  it("rejects bytes that are not valid utf-8 when the recipe says utf-8", () => {
    expect(() => parseNative(bytesOf("1 \u00e9\n"), edgeList())).toThrow(/not valid utf-8/);
  });

  it("reads latin1 bytes as ISO-8859-1, including the range windows-1252 reassigns", () => {
    expect(parseNative(bytesOf("a \u00e9\u0080\n"), edgeList({ encoding: "latin1" })).edges).toEqual([{ source: "a", target: "\u00e9\u0080" }]);
  });
});
