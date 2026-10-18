import { NativeParseError } from "../errors";
import { lines, type NativeEdge, type NativeGraph, type NativeNode } from "./native";

/** An entry line starts with its row and column. */
const COORDINATES = 2;

/** How many tokens an entry line of each field type holds: the coordinates, then the value's parts (none for a pattern, a real and an imaginary part for a complex value). */
const tokensPerEntry: ReadonlyMap<string, number> = new Map([
  ["pattern", COORDINATES],
  ["real", COORDINATES + 1],
  ["integer", COORDINATES + 1],
  ["complex", COORDINATES + 2],
]);

/** The fields of the size line, in order. */
const SIZE_FIELDS = ["rows", "columns", "entries"] as const;

const symmetries = new Set(["general", "symmetric", "skew-symmetric", "hermitian"]);

/**
 * Reads a positive integer token.
 * @param token - The token.
 * @param line - The 1-based line, for the error.
 * @param what - What the token is, for the error.
 * @returns The integer.
 */
function positiveInteger(token: string | undefined, line: number, what: string): number {
  if (token === undefined || !/^[1-9]\d*$/.test(token)) {
    throw new NativeParseError("matrix-market", line, `${what} must be a positive integer, found ${JSON.stringify(token)}`);
  }

  return Number(token);
}

/**
 * Parses a Matrix Market coordinate file (https://math.nist.gov/MatrixMarket/formats.html) as a graph: each stored entry is one edge from its row to its column, and entry values are not carried. A square matrix's nodes are `1` to `n`, isolated ones included; a rectangular matrix is bipartite, with row nodes `r1` to `rM` and column nodes `c1` to `cN`. A symmetric, skew-symmetric or Hermitian file stores one triangle, and each stored entry stays one edge: the graph's direction is recorded in the entry's properties, never by duplicating edges.
 * @param text - The file text.
 * @returns The native graph.
 * @throws NativeParseError naming the line for a missing or unsupported header, an array-format file, a malformed size line, an entry outside the matrix or with the wrong number of tokens, or an entry count that disagrees with the size line.
 */
export function parseMatrixMarket(text: string): NativeGraph {
  const all = lines(text);
  const [first] = all;
  if (first === undefined) {
    throw new NativeParseError("matrix-market", 1, "the file is empty");
  }
  const [banner, object, layout, field, symmetry] = first
    .trim()
    .split(/\s+/)
    .map((token) => token.toLowerCase());
  if (banner !== "%%matrixmarket" || object !== "matrix") {
    throw new NativeParseError("matrix-market", 1, "expected a '%%MatrixMarket matrix' header");
  }
  if (layout !== "coordinate") {
    throw new NativeParseError("matrix-market", 1, `only the coordinate layout is supported, found ${JSON.stringify(layout)}`);
  }
  const perEntry = field === undefined ? undefined : tokensPerEntry.get(field);
  if (perEntry === undefined) {
    throw new NativeParseError("matrix-market", 1, `unknown field type ${JSON.stringify(field)}`);
  }
  if (symmetry === undefined || !symmetries.has(symmetry)) {
    throw new NativeParseError("matrix-market", 1, `unknown symmetry ${JSON.stringify(symmetry)}`);
  }

  let size: { rows: number; columns: number; entries: number } | undefined;
  const edges: NativeEdge[] = [];
  let rowId = (row: number): string => String(row);
  let columnId = (column: number): string => String(column);
  for (const [index, line] of all.entries()) {
    const lineNumber = index + 1;
    const content = line.trim();
    if (index === 0 || content === "" || content.startsWith("%")) {
      continue;
    }
    const tokens = content.split(/\s+/);
    if (size === undefined) {
      if (tokens.length !== SIZE_FIELDS.length) {
        throw new NativeParseError("matrix-market", lineNumber, "the size line must be 'rows columns entries'");
      }
      size = { rows: positiveInteger(tokens[0], lineNumber, "rows"), columns: positiveInteger(tokens[1], lineNumber, "columns"), entries: positiveInteger(tokens[2], lineNumber, "entries") };
      if (size.rows !== size.columns) {
        rowId = (row) => `r${String(row)}`;
        columnId = (column) => `c${String(column)}`;
      }
      continue;
    }
    if (tokens.length !== perEntry) {
      throw new NativeParseError("matrix-market", lineNumber, `a ${String(field)} entry has ${String(perEntry)} tokens, found ${String(tokens.length)}`);
    }
    const row = positiveInteger(tokens[0], lineNumber, "the row");
    const column = positiveInteger(tokens[1], lineNumber, "the column");
    if (row > size.rows || column > size.columns) {
      throw new NativeParseError("matrix-market", lineNumber, `entry (${String(row)}, ${String(column)}) lies outside the ${String(size.rows)} by ${String(size.columns)} matrix`);
    }
    edges.push({ source: rowId(row), target: columnId(column) });
  }
  if (size === undefined) {
    throw new NativeParseError("matrix-market", all.length, "the file has no size line");
  }
  if (edges.length !== size.entries) {
    throw new NativeParseError("matrix-market", all.length, `the size line declares ${String(size.entries)} entries but the file holds ${String(edges.length)}`);
  }

  const nodes: NativeNode[] = [];
  for (let row = 1; row <= size.rows; row++) {
    nodes.push({ id: rowId(row) });
  }
  if (size.rows !== size.columns) {
    for (let column = 1; column <= size.columns; column++) {
      nodes.push({ id: columnId(column) });
    }
  }

  return { nodes, edges };
}
