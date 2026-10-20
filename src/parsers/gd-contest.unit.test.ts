import { describe, expect, it } from "vitest";
import { NativeParseError } from "../errors";
import { parseNative } from "./parse-native";

const text = (...lines: readonly string[]): Uint8Array => new TextEncoder().encode(`${lines.join("\n")}\n`);

const gd = { format: "gd-contest", encoding: "utf-8" } as const;

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

/** The whole of challenge/prob4.gd4 from the GD 2004 contest archive: a vertex count, a random starting position per vertex, then the edges. */
const PROB4 = [
  "20",
  "812.0 775.0",
  "620.0 545.0",
  "137.0 227.0",
  "225.0 657.0",
  "250.0 867.0",
  "152.0 479.0",
  "604.0 390.0",
  "566.0 289.0",
  "839.0 302.0",
  "450.0 378.0",
  "602.0 686.0",
  "247.0 365.0",
  "843.0 863.0",
  "922.0 597.0",
  "199.0 919.0",
  "446.0 667.0",
  "567.0 150.0",
  "503.0 860.0",
  "979.0 494.0",
  "819.0 958.0",
  "0 1",
  "3 7",
  "2 8",
  "3 9",
  "6 9",
  "8 9",
  "2 10",
  "3 10",
  "7 10",
  "3 11",
  "6 11",
  "8 11",
  "5 12",
  "7 12",
  "2 13",
  "3 13",
  "3 14",
  "11 14",
  "4 15",
  "8 15",
  "10 15",
  "0 16",
  "5 16",
  "6 16",
  "9 16",
  "4 17",
  "9 17",
  "0 18",
  "1 18",
  "4 18",
  "5 18",
  "7 18",
  "11 18",
  "0 19",
  "7 19",
  "15 19",
];

describe("the Graph Drawing contest parser", () => {
  it("reads nodes 0 to N - 1 and the edges after the coordinates, in file order (the whole of prob4.gd4)", () => {
    const graph = parseNative(text(...PROB4), gd);
    const count = Number(PROB4[0]);
    expect(graph.nodes).toEqual(Array.from({ length: count }, (_, id) => ({ id: String(id) })));
    // Each line after the count holds one vertex's coordinates or one edge.
    expect(graph.edges).toHaveLength(PROB4.length - 1 - count);
    expect(graph.edges.slice(0, 2)).toEqual([
      { source: "0", target: "1" },
      { source: "3", target: "7" },
    ]);
    expect(graph.edges.at(-1)).toEqual({ source: "15", target: "19" });
  });

  it("skips comments, whole-line and trailing, and CRLF line ends (the contest rules' sample)", () => {
    const sample = [
      "# Lines starting with # are comments and ignored",
      "# First value is NumNodes(N)",
      "4 ",
      "# Next N pairs are X,Y (double) coordinate values of each node 0,1, N-1",
      "0.0 0.0  # Node 0",
      "0.0 5.0  # Node 1",
      "5.0 5.0  # Node 2",
      "5.0 0.0  # Node 4",
      "# Remaining pairs of INTEGER values are undirected edges Ns, Ne",
      "0 1      # Edge from Node 0 to Node 1",
      "0 2",
      "0 3",
      "1 2",
      "1 3",
      "2 3",
      "# Here we defined a 4-clique (with 1 crossing)",
    ];
    const graph = parseNative(new TextEncoder().encode(sample.join("\r\n")), gd);
    expect(graph.nodes.map((node) => node.id)).toEqual(["0", "1", "2", "3"]);
    expect(graph.edges).toEqual([
      { source: "0", target: "1" },
      { source: "0", target: "2" },
      { source: "0", target: "3" },
      { source: "1", target: "2" },
      { source: "1", target: "3" },
      { source: "2", target: "3" },
    ]);
  });

  it("keeps isolated vertices as nodes", () => {
    expect(parseNative(text("3", "0 0", "1 1", "2 2", "0 2"), gd)).toEqual({ nodes: [{ id: "0" }, { id: "1" }, { id: "2" }], edges: [{ source: "0", target: "2" }] });
  });

  it("refuses a missing or malformed vertex count", () => {
    expect(() => parseNative(text("# nothing"), gd)).toThrow(/no vertex count/);
    expect(parseError(() => parseNative(text("", "2.5"), gd)).line).toBe(2);
  });

  it("refuses too few coordinates or a coordinate that is not a number", () => {
    expect(() => parseNative(text("2", "0 0", "1"), gd)).toThrow(/expected 4 coordinates/);
    const file = ["2", "0 0", "1 y", "0 1"];
    expect(parseError(() => parseNative(text(...file), gd)).line).toBe(file.indexOf("1 y") + 1);
  });

  it("refuses a vertex number outside 0 to N - 1 and an edge missing its second vertex", () => {
    const file = ["2", "0 0", "1 1", "0 1", "1 2"];
    expect(parseError(() => parseNative(text(...file), gd)).line).toBe(file.indexOf("1 2") + 1);
    expect(() => parseNative(text("2", "0 0", "1 1", "0 1", "1"), gd)).toThrow(/has no second vertex/);
    expect(() => parseNative(text("2", "0 0", "1 1", "0 1.0"), gd)).toThrow(/expected a vertex number/);
  });
});
