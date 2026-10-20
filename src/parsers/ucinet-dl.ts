import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import { lines, type NativeEdge, type NativeGraph, type NativeNode } from "./native";

type UcinetDlParser = Extract<Parser, { format: "ucinet-dl" }>;

const FORMAT = "ucinet-dl";

/** A label section's keyword, upper-cased with its spacing collapsed, mapped to which labels it gives: `LABELS:` names the rows and columns of a one-mode matrix at once, `LEVEL LABELS:` (or `MATRIX LABELS:`) names the matrices. */
const LABEL_SECTIONS: ReadonlyMap<string, LabelTarget> = new Map([
  ["LABELS", "both"],
  ["ROW LABELS", "rows"],
  ["COLUMN LABELS", "columns"],
  ["COL LABELS", "columns"],
  ["LEVEL LABELS", "matrices"],
  ["MATRIX LABELS", "matrices"],
]);

type LabelTarget = "both" | "rows" | "columns" | "matrices";

/** The FORMAT values that name the full matrix layout, the only one this version reads. */
const FULL_MATRIX = new Set(["FULLMATRIX", "FM"]);

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[Ee][+-]?\d+)?$/;

/**
 * Splits label text into labels: separated by commas, spaces or line breaks, and a double-quoted label may hold spaces or commas.
 * @param text - The text.
 * @returns The labels.
 */
function labelsOf(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"|[^\s,]+/g)].map((match) => match[1] ?? match[0]);
}

/**
 * Reads a dimension parameter's value.
 * @param value - The text after `=`.
 * @param key - The parameter, for the error.
 * @param line - The 1-based line, for the error.
 * @returns The dimension.
 */
function dimension(value: string, key: string, line: number): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new NativeParseError(FORMAT, line, `${key} must be a positive integer, found ${JSON.stringify(value)}`);
  }

  return Number(value);
}

/** The header a DL file declares before its data. */
interface Header {
  n?: number;
  nr?: number;
  nc?: number;
  nm?: number;
  format?: string;
  diagonal?: "PRESENT" | "ABSENT";
  readonly labels: Partial<Record<LabelTarget, { readonly values: string[]; readonly line: number }>>;
}

/** The dimension parameters, upper-cased, mapped to the header field each sets: N actors of a one-mode matrix, NR rows and NC columns of a two-mode one, NM matrices. */
const DIMENSIONS: ReadonlyMap<string, "n" | "nr" | "nc" | "nm"> = new Map([
  ["N", "n"],
  ["NR", "nr"],
  ["NC", "nc"],
  ["NM", "nm"],
]);

/** One parameter a header line sets. */
type Parameter = { readonly kind: "dimension"; readonly field: "n" | "nr" | "nc" | "nm"; readonly key: string; readonly value: number } | { readonly kind: "format"; readonly value: string } | { readonly kind: "diagonal"; readonly value: "PRESENT" | "ABSENT" };

/**
 * Reads the parameters on one header line (`DL N=58 NM=2`, `FORMAT = FULLMATRIX DIAGONAL PRESENT`), separated by spaces or commas, with any spacing around `=`.
 * @param text - The line, after any leading `DL`.
 * @param line - The 1-based line, for the error.
 * @returns The parameters, in line order.
 */
function readParameters(text: string, line: number): Parameter[] {
  const parameters: Parameter[] = [];
  const tokens = text
    .replace(/\s*=\s*/g, "=")
    .split(/[\s,]+/)
    .filter((token) => token !== "");
  for (let token = tokens.shift(); token !== undefined; token = tokens.shift()) {
    const upper = token.toUpperCase();
    const equals = upper.indexOf("=");
    if (equals === -1) {
      const next = tokens[0]?.toUpperCase();
      if (upper === "DIAGONAL" && (next === "PRESENT" || next === "ABSENT")) {
        parameters.push({ kind: "diagonal", value: next });
        tokens.shift();
        continue;
      }
      throw new NativeParseError(FORMAT, line, `unknown header token ${JSON.stringify(token)}`);
    }
    const key = upper.slice(0, equals);
    const value = token.slice(equals + 1);
    const field = DIMENSIONS.get(key);
    if (field !== undefined) {
      parameters.push({ kind: "dimension", field, key, value: dimension(value, key, line) });
    } else if (key === "FORMAT") {
      parameters.push({ kind: "format", value: value.toUpperCase() });
    } else {
      throw new NativeParseError(FORMAT, line, `unknown header parameter ${key}`);
    }
  }

  return parameters;
}

/**
 * Checks a label list's length and uniqueness.
 * @param labels - The section, when the file has one.
 * @param count - How many labels it must hold.
 * @param what - What the labels name, for the error.
 * @returns The labels, or undefined when the file has none.
 */
function checked(labels: { readonly values: readonly string[]; readonly line: number } | undefined, count: number, what: string): readonly string[] | undefined {
  if (labels === undefined) {
    return undefined;
  }
  if (labels.values.length !== count) {
    throw new NativeParseError(FORMAT, labels.line, `expected ${String(count)} ${what} labels, found ${String(labels.values.length)}`);
  }
  const seen = new Set<string>();
  for (const label of labels.values) {
    if (seen.has(label)) {
      throw new NativeParseError(FORMAT, labels.line, `${what} label ${JSON.stringify(label)} appears twice`);
    }
    seen.add(label);
  }

  return labels.values;
}

/**
 * Parses a UCINet DL file (the Data Language of Borgatti, Everett and Freeman's UCINET, as its help describes it) in the full matrix layout as a graph, reading the one matrix the recipe names by its 1-based position among the file's `NM` matrices.
 *
 * A one-mode file (`N=n`) has nodes for its n actors, named by their `LABELS:`, `ROW LABELS:` or `COLUMN LABELS:` (which must agree where more than one is given) and otherwise numbered `1` to `n`. A two-mode file (`NR=r NC=c`) has nodes for its r rows followed by its c columns, named by `ROW LABELS:` and `COLUMN LABELS:` and otherwise `r1` to `rR` and `c1` to `cC`; a row and a column may not share a name, because they are different entities. Every non-zero cell of the chosen matrix is one edge from its row to its column, in row-major order, so a symmetric matrix gives each tie in both directions; cell values (tie strengths) are not carried in this version, nor are the `LEVEL LABELS:` that name the matrices, which are only checked to number `NM`.
 * @param text - The file text.
 * @param options - The recipe's parser, which names the matrix to read.
 * @returns The native graph.
 * @throws NativeParseError naming the line for a file that does not start with `DL`, a missing or contradictory dimension, a layout other than the full matrix, an absent diagonal, embedded labels, a label list of the wrong length or with a repeat, a matrix position beyond `NM`, a non-numeric cell, or a data section that does not hold exactly NM full matrices.
 */
export function parseUcinetDl(text: string, options: Readonly<UcinetDlParser>): NativeGraph {
  const all = lines(text);
  const header: Header = { labels: {} };
  const setParameters = (parameterText: string, line: number): void => {
    for (const parameter of readParameters(parameterText, line)) {
      if (parameter.kind === "dimension") {
        if (header[parameter.field] !== undefined) {
          throw new NativeParseError(FORMAT, line, `${parameter.key} is declared twice`);
        }
        header[parameter.field] = parameter.value;
      } else if (parameter.kind === "format") {
        header.format = parameter.value;
      } else {
        header.diagonal = parameter.value;
      }
    }
  };
  let started = false;
  let section: LabelTarget | undefined;
  let dataLine: number | undefined;
  const cells: { readonly text: string; readonly line: number }[] = [];
  for (const [index, raw] of all.entries()) {
    const lineNumber = index + 1;
    const content = raw.trim();
    if (dataLine !== undefined) {
      for (const cell of content.split(/\s+/).filter((token) => token !== "")) {
        cells.push({ text: cell, line: lineNumber });
      }
      continue;
    }
    if (content === "") {
      continue;
    }
    if (!started) {
      const match = /^DL(?:\s+(.*))?$/i.exec(content);
      if (match === null) {
        throw new NativeParseError(FORMAT, lineNumber, "a DL file starts with the keyword DL");
      }
      started = true;
      if (match[1] !== undefined) {
        setParameters(match[1], lineNumber);
      }
      continue;
    }
    // A line that opens a label section or the data names it before a colon, and the text after the colon already belongs to that section.
    const colon = content.indexOf(":");
    const keyword = colon === -1 ? undefined : content.slice(0, colon).trim().toUpperCase().replace(/\s+/g, " ");
    const rest = content.slice(colon + 1);
    if (keyword === "DATA") {
      dataLine = lineNumber;
      for (const cell of rest.split(/\s+/).filter((token) => token !== "")) {
        cells.push({ text: cell, line: lineNumber });
      }
      continue;
    }
    const target = keyword === undefined ? undefined : LABEL_SECTIONS.get(keyword);
    if (target !== undefined) {
      if (header.labels[target] !== undefined) {
        throw new NativeParseError(FORMAT, lineNumber, `${String(keyword)} is given twice`);
      }
      section = target;
      header.labels[target] = { values: labelsOf(rest), line: lineNumber };
      continue;
    }
    if (/^LABELS\s+EMBEDDED\b/i.test(content)) {
      throw new NativeParseError(FORMAT, lineNumber, "labels embedded in the data are not read in this version");
    }
    if (section === undefined) {
      setParameters(content, lineNumber);
    } else {
      header.labels[section]?.values.push(...labelsOf(content));
    }
  }
  if (!started) {
    throw new NativeParseError(FORMAT, 1, "the file is empty");
  }
  if (dataLine === undefined) {
    throw new NativeParseError(FORMAT, all.length, "the file has no DATA: section");
  }
  const format = header.format ?? "FULLMATRIX";
  if (!FULL_MATRIX.has(format)) {
    throw new NativeParseError(FORMAT, dataLine, `format ${format} is not read in this version; only the full matrix layout is`);
  }
  if (header.diagonal === "ABSENT") {
    throw new NativeParseError(FORMAT, dataLine, "a full matrix with its diagonal absent is not read in this version");
  }
  const twoMode = header.nr !== undefined || header.nc !== undefined;
  if (twoMode === (header.n !== undefined) || (twoMode && (header.nr === undefined || header.nc === undefined))) {
    throw new NativeParseError(FORMAT, dataLine, "the header must give either N, or both NR and NC");
  }
  const rows = header.n ?? header.nr ?? 0;
  const columns = header.n ?? header.nc ?? 0;
  const matrices = header.nm ?? 1;
  checked(header.labels.matrices, matrices, "matrix");
  if (options.matrix > matrices) {
    throw new NativeParseError(FORMAT, dataLine, `the recipe reads matrix ${String(options.matrix)} but the file holds ${String(matrices)}`);
  }

  let rowIds: readonly string[];
  let columnIds: readonly string[];
  if (twoMode) {
    if (header.labels.both !== undefined) {
      throw new NativeParseError(FORMAT, header.labels.both.line, "a two-mode file names its rows and columns with ROW LABELS: and COLUMN LABELS:, not LABELS:");
    }
    rowIds = checked(header.labels.rows, rows, "row") ?? Array.from({ length: rows }, (_, row) => `r${String(row + 1)}`);
    columnIds = checked(header.labels.columns, columns, "column") ?? Array.from({ length: columns }, (_, column) => `c${String(column + 1)}`);
    const rowSet = new Set(rowIds);
    const shared = columnIds.find((id) => rowSet.has(id));
    if (shared !== undefined) {
      throw new NativeParseError(FORMAT, dataLine, `the row and column label ${JSON.stringify(shared)} names two different entities`);
    }
  } else {
    const given = [checked(header.labels.both, rows, "actor"), checked(header.labels.rows, rows, "row"), checked(header.labels.columns, columns, "column")].filter((labels) => labels !== undefined);
    const [first] = given;
    if (first !== undefined && given.some((labels) => labels.some((label, position) => label !== first[position]))) {
      throw new NativeParseError(FORMAT, dataLine, "a one-mode file's row and column labels must be the same actors in the same order");
    }
    rowIds = first ?? Array.from({ length: rows }, (_, row) => String(row + 1));
    columnIds = rowIds;
  }

  const perMatrix = rows * columns;
  if (cells.length !== perMatrix * matrices) {
    throw new NativeParseError(FORMAT, cells.at(-1)?.line ?? dataLine, `expected ${String(matrices)} full ${String(rows)} by ${String(columns)} matrices (${String(perMatrix * matrices)} cells), found ${String(cells.length)} cells`);
  }
  for (const cell of cells) {
    if (!NUMBER.test(cell.text)) {
      throw new NativeParseError(FORMAT, cell.line, `cell ${JSON.stringify(cell.text)} is not a number`);
    }
  }
  const chosen = cells.slice((options.matrix - 1) * perMatrix, options.matrix * perMatrix);
  const edges: NativeEdge[] = [];
  for (const [row, source] of rowIds.entries()) {
    for (const [column, target] of columnIds.entries()) {
      const cell = chosen[row * columns + column];
      // The cell count was checked against NM full matrices above, so every row and column has its cell.
      if (cell === undefined) {
        throw new NativeParseError(FORMAT, dataLine, `matrix ${String(options.matrix)} has no cell at row ${String(row + 1)}, column ${String(column + 1)}`);
      }
      if (Number(cell.text) !== 0) {
        edges.push({ source, target });
      }
    }
  }
  const nodes: NativeNode[] = (twoMode ? [...rowIds, ...columnIds] : rowIds).map((id) => ({ id }));

  return { nodes, edges };
}
