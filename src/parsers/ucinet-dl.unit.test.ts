import { describe, expect, it } from "vitest";
import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import { parseNative } from "./parse-native";

/** A file's lines joined with CRLF, as every UCINet file the catalogue reads is written. */
const crlf = (...lines: readonly string[]): Uint8Array => new TextEncoder().encode(`${lines.join("\r\n")}\r\n`);

const dl = (matrix = 1): Extract<Parser, { format: "ucinet-dl" }> => ({ format: "ucinet-dl", encoding: "utf-8", matrix });

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

/** The whole of davis.dat (Davis, Gardner and Gardner's Southern women), as the Pajek site's UciNet directory served it: a two-mode full matrix with row and column labels. */
const DAVIS = [
  "DL",
  "NR=18 NC=14",
  "FORMAT = FULLMATRIX DIAGONAL PRESENT",
  "ROW LABELS:",
  "EVELYN",
  "LAURA",
  "THERESA",
  "BRENDA",
  "CHARLOTTE",
  "FRANCES",
  "ELEANOR",
  "PEARL",
  "RUTH",
  "VERNE",
  "MYRNA",
  "KATHERINE",
  "SYLVIA",
  "NORA",
  "HELEN",
  "DOROTHY",
  "OLIVIA",
  "FLORA",
  "COLUMN LABELS:",
  "E1",
  "E2",
  "E3",
  "E4",
  "E5",
  "E6",
  "E7",
  "E8",
  "E9",
  "E10",
  "E11",
  "E12",
  "E13",
  "E14",
  "DATA:",
  " 1 1 1 1 1 1 0 1 1 0 0 0 0 0",
  " 1 1 1 0 1 1 1 1 0 0 0 0 0 0",
  " 0 1 1 1 1 1 1 1 1 0 0 0 0 0",
  " 1 0 1 1 1 1 1 1 0 0 0 0 0 0",
  " 0 0 1 1 1 0 1 0 0 0 0 0 0 0",
  " 0 0 1 0 1 1 0 1 0 0 0 0 0 0",
  " 0 0 0 0 1 1 1 1 0 0 0 0 0 0",
  " 0 0 0 0 0 1 0 1 1 0 0 0 0 0",
  " 0 0 0 0 1 0 1 1 1 0 0 0 0 0",
  " 0 0 0 0 0 0 1 1 1 0 0 1 0 0",
  " 0 0 0 0 0 0 0 1 1 1 0 1 0 0",
  " 0 0 0 0 0 0 0 1 1 1 0 1 1 1",
  " 0 0 0 0 0 0 1 1 1 1 0 1 1 1",
  " 0 0 0 0 0 1 1 0 1 1 1 1 1 1",
  " 0 0 0 0 0 0 1 1 0 1 1 1 1 1",
  " 0 0 0 0 0 0 0 1 1 1 0 1 0 0",
  " 0 0 0 0 0 0 0 0 1 0 1 0 0 0",
  " 0 0 0 0 0 0 0 0 1 0 1 0 0 0",
];

describe("the UCINet DL parser", () => {
  it("reads a one-mode full matrix without labels as nodes 1 to N, a row wrapped across lines included (taro.dat and prison.dat)", () => {
    const text = crlf("DL", "N=3", "FORMAT = FULLMATRIX DIAGONAL PRESENT", "DATA:", " 0 1 0", " 1", " 0 1", " 0 1 0");
    expect(parseNative(text, dl())).toEqual({
      nodes: [{ id: "1" }, { id: "2" }, { id: "3" }],
      edges: [
        { source: "1", target: "2" },
        { source: "2", target: "1" },
        { source: "2", target: "3" },
        { source: "3", target: "2" },
      ],
    });
  });

  it("names a one-mode file's nodes by its row and column labels, and reads only the matrix the recipe names (padgett.dat)", () => {
    const text = crlf(
      "DL",
      "N=3 NM=2",
      "FORMAT = FULLMATRIX DIAGONAL PRESENT",
      "ROW LABELS:",
      "ACCIAIUOL",
      "ALBIZZI",
      "MEDICI",
      "COLUMN LABELS:",
      "ACCIAIUOL",
      "ALBIZZI",
      "MEDICI",
      "LEVEL LABELS:",
      "PADGM",
      "PADGB",
      "DATA:",
      " 0 0 1",
      " 0 0 1",
      " 1 1 0",
      " 0 0 0",
      " 0 0 1",
      " 0 1 0",
    );
    expect(parseNative(text, dl(1))).toEqual({
      nodes: [{ id: "ACCIAIUOL" }, { id: "ALBIZZI" }, { id: "MEDICI" }],
      edges: [
        { source: "ACCIAIUOL", target: "MEDICI" },
        { source: "ALBIZZI", target: "MEDICI" },
        { source: "MEDICI", target: "ACCIAIUOL" },
        { source: "MEDICI", target: "ALBIZZI" },
      ],
    });
    expect(parseNative(text, dl(2)).edges).toEqual([
      { source: "ALBIZZI", target: "MEDICI" },
      { source: "MEDICI", target: "ALBIZZI" },
    ]);
  });

  it("numbers the nodes of a file whose only labels name its matrices, and reads a valued cell as one edge (zachary.dat)", () => {
    const text = crlf("DL", "N=2 NM=2", "FORMAT = FULLMATRIX DIAGONAL PRESENT", "LEVEL LABELS:", "ZACHE", "ZACHC", "DATA:", " 0 1", " 1 0", " 0 4", " 4 0");
    expect(parseNative(text, dl(2))).toEqual({
      nodes: [{ id: "1" }, { id: "2" }],
      edges: [
        { source: "1", target: "2" },
        { source: "2", target: "1" },
      ],
    });
  });

  it("names the actors of a LABELS: section, comma-separated or quoted", () => {
    const text = crlf("DL N=3", "LABELS:", 'a,"b c"', "d", "DATA:", "0 1 0 0 0 0 0 0 1");
    expect(parseNative(text, dl())).toEqual({
      nodes: [{ id: "a" }, { id: "b c" }, { id: "d" }],
      edges: [
        { source: "a", target: "b c" },
        { source: "d", target: "d" },
      ],
    });
  });

  it("reads a two-mode file's rows then columns as nodes, each cell an edge from its row to its column (the whole of davis.dat)", () => {
    const graph = parseNative(crlf(...DAVIS), dl());
    const rows = DAVIS.indexOf("ROW LABELS:");
    const columns = DAVIS.indexOf("COLUMN LABELS:");
    const data = DAVIS.indexOf("DATA:");
    const ties = DAVIS.slice(data + 1).flatMap((line) => line.trim().split(/\s+/)).filter((cell) => cell === "1").length;
    expect(graph.nodes.map((node) => node.id)).toEqual([...DAVIS.slice(rows + 1, columns), ...DAVIS.slice(columns + 1, data)]);
    expect(graph.edges).toHaveLength(ties);
    expect(graph.edges.slice(0, ["E1", "E2", "E3"].length)).toEqual([
      { source: "EVELYN", target: "E1" },
      { source: "EVELYN", target: "E2" },
      { source: "EVELYN", target: "E3" },
    ]);
    expect(graph.edges.at(-1)).toEqual({ source: "FLORA", target: "E11" });
  });

  it("numbers an unlabelled two-mode file's rows and columns apart", () => {
    expect(parseNative(crlf("DL", "NR=1 NC=2", "DATA:", "0 1"), dl())).toEqual({ nodes: [{ id: "r1" }, { id: "c1" }, { id: "c2" }], edges: [{ source: "r1", target: "c2" }] });
  });

  it("refuses a file that is not DL, naming the line (knokbur.dat)", () => {
    expect(parseError(() => parseNative(crlf("has to be converted into DL format ", "information", " 4 , 10 , 10 ,N,NB"), dl())).line).toBe(1);
  });

  it("refuses a layout other than the full matrix, and embedded labels", () => {
    expect(() => parseNative(crlf("DL N=2", "FORMAT = EDGELIST1", "DATA:", "1 2"), dl())).toThrow(/format EDGELIST1 is not read/);
    expect(() => parseNative(crlf("DL N=2", "FORMAT = FULLMATRIX DIAGONAL ABSENT", "DATA:", "0 1 1 0"), dl())).toThrow(/diagonal absent/);
    expect(() => parseNative(crlf("DL N=2", "LABELS EMBEDDED", "DATA:", "x a b", "a 0 1", "b 1 0"), dl())).toThrow(/embedded/);
  });

  it("refuses a data section that does not hold NM full matrices, or a cell that is not a number", () => {
    expect(() => parseNative(crlf("DL N=2 NM=2", "DATA:", "0 1 1 0"), dl())).toThrow(/expected 2 full 2 by 2 matrices/);
    const file = ["DL N=2", "DATA:", "0 1", "1 x"];
    expect(parseError(() => parseNative(crlf(...file), dl())).line).toBe(file.indexOf("1 x") + 1);
  });

  it("refuses a matrix position past NM, and level labels that do not number NM", () => {
    expect(() => parseNative(crlf("DL N=1 NM=2", "DATA:", "0 0"), dl(["first", "second", "third"].length))).toThrow(/reads matrix 3 but the file holds 2/);
    expect(() => parseNative(crlf("DL N=1 NM=2", "LEVEL LABELS:", "ONLY", "DATA:", "0 0"), dl())).toThrow(/expected 2 matrix labels/);
  });

  it("refuses labels of the wrong length, repeated, disagreeing between rows and columns, or shared between the modes", () => {
    expect(() => parseNative(crlf("DL N=2", "ROW LABELS:", "A", "DATA:", "0 0 0 0"), dl())).toThrow(/expected 2 row labels/);
    expect(() => parseNative(crlf("DL N=2", "ROW LABELS:", "A", "A", "DATA:", "0 0 0 0"), dl())).toThrow(/appears twice/);
    expect(() => parseNative(crlf("DL N=2", "ROW LABELS:", "A", "B", "COLUMN LABELS:", "B", "A", "DATA:", "0 0 0 0"), dl())).toThrow(/same actors in the same order/);
    expect(() => parseNative(crlf("DL NR=1 NC=1", "ROW LABELS:", "A", "COLUMN LABELS:", "A", "DATA:", "1"), dl())).toThrow(/two different entities/);
  });

  it("refuses a header without N, or with N beside NR and NC", () => {
    expect(() => parseNative(crlf("DL NM=1", "DATA:", "0"), dl())).toThrow(/either N, or both NR and NC/);
    expect(() => parseNative(crlf("DL N=1 NR=1 NC=1", "DATA:", "0"), dl())).toThrow(/either N, or both NR and NC/);
  });
});
