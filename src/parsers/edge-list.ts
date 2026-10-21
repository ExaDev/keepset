import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import { lines, NodeOrder, type NativeEdge, type NativeGraph } from "./native";

type EdgeListParser = Extract<Parser, { format: "edge-list" }>;

/** How each fixed delimiter option splits a line into fields. */
const splitters: Readonly<Record<Exclude<EdgeListParser["delimiter"], "detect">, (line: string) => string[]>> = {
  whitespace: (line) => line.trim().split(/\s+/),
  tab: (line) => line.split("\t"),
  comma: (line) => line.split(","),
  space: (line) => line.split(" "),
};

/**
 * Reads one endpoint field, trimmed.
 * @param fields - The line's fields.
 * @param column - The endpoint's column.
 * @param lineNumber - The 1-based line, for the error.
 * @returns The endpoint id.
 * @throws NativeParseError when the column is absent or empty.
 */
function endpoint(fields: readonly string[], column: number, lineNumber: number): string {
  const value = fields[column];
  if (value === undefined || value.trim() === "") {
    throw new NativeParseError("edge-list", lineNumber, `column ${String(column)} holds no node id`);
  }

  return value.trim();
}

/**
 * Resolves `detect` to a fixed delimiter from the first data line: tab when it holds a tab, comma when it holds a comma, whitespace otherwise. The rule is a function of the file's bytes, so a recipe that detects still reads the same way every time.
 * @param dataLine - The first line that is neither skipped, blank nor a comment.
 * @returns The fixed delimiter.
 */
function detect(dataLine: string): Exclude<EdgeListParser["delimiter"], "detect"> {
  if (dataLine.includes("\t")) {
    return "tab";
  }

  return dataLine.includes(",") ? "comma" : "whitespace";
}

/**
 * Reads a line's multiplicity.
 * @param fields - The line's fields.
 * @param column - The multiplicity column.
 * @param lineNumber - The 1-based line, for the error.
 * @returns How many edges the line stands for.
 * @throws NativeParseError when the field is not a whole number.
 */
function multiplicity(fields: readonly string[], column: number, lineNumber: number): number {
  const value = fields[column]?.trim() ?? "";
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new NativeParseError("edge-list", lineNumber, `column ${String(column)} holds ${JSON.stringify(value)}, which is not a whole number of edges`);
  }

  return Number(value);
}

/**
 * Parses a delimited edge list: one edge per line, source and target in the configured columns, after `skipLines` header lines, with blank lines and lines whose first non-blank characters are a comment prefix skipped. A `detect` delimiter is fixed from the first data line. A recipe that names a `keep` column reads only the lines whose field there is one of its values; one that names a `multiplicityColumn` emits as many edges for a line as the field says, none for a zero; one that says `mirrored` emits each pair of mirror-image lines once. Nodes are the endpoints of the lines read, in order of first appearance.
 * @param text - The file text.
 * @param options - The recipe's edge-list parser.
 * @returns The native graph.
 * @throws NativeParseError naming the line when a data line has too few fields, an empty endpoint or a multiplicity that is not a whole number, when a mirrored table has a line without its mirror, or when the file holds no edges.
 */
export function parseEdgeList(text: string, options: Readonly<EdgeListParser>): NativeGraph {
  let split = options.delimiter === "detect" ? undefined : splitters[options.delimiter];
  const needed = Math.max(options.sourceColumn, options.targetColumn, options.keep?.column ?? 0, options.multiplicityColumn ?? 0) + 1;
  const order = new NodeOrder();
  const edges: NativeEdge[] = [];
  // For a mirrored table: the lines still awaiting their mirror, keyed by the mirror's endpoints and multiplicity, each with the line it was read from.
  const awaiting = new Map<string, number[]>();
  const all = lines(text);
  for (const [index, line] of all.entries()) {
    const lineNumber = index + 1;
    const content = line.trimStart();
    if (index < options.skipLines || content === "" || options.commentPrefixes.some((prefix) => content.startsWith(prefix))) {
      continue;
    }
    split ??= splitters[detect(line)];
    const fields = split(line);
    if (fields.length < needed) {
      throw new NativeParseError("edge-list", lineNumber, `expected at least ${String(needed)} fields, found ${String(fields.length)}`);
    }
    if (options.keep !== undefined && !options.keep.values.includes(fields[options.keep.column]?.trim() ?? "")) {
      continue;
    }
    const source = endpoint(fields, options.sourceColumn, lineNumber);
    const target = endpoint(fields, options.targetColumn, lineNumber);
    const count = options.multiplicityColumn === undefined ? 1 : multiplicity(fields, options.multiplicityColumn, lineNumber);
    // A line that stands for no edges (a pair a connectome lists with no synapses) is not read at all, so it adds no node either.
    if (count === 0) {
      continue;
    }
    order.add(source);
    order.add(target);
    if (options.mirrored === true && source !== target) {
      const key = JSON.stringify([source, target, count]);
      const waiting = awaiting.get(key);
      if (waiting !== undefined && waiting.length > 0) {
        waiting.shift();
        continue;
      }
      const mirror = JSON.stringify([target, source, count]);
      awaiting.set(mirror, [...(awaiting.get(mirror) ?? []), lineNumber]);
    }
    for (let copy = 0; copy < count; copy += 1) {
      edges.push({ source, target });
    }
  }
  for (const [key, waiting] of awaiting) {
    const [first] = waiting;
    if (first !== undefined) {
      throw new NativeParseError("edge-list", first, `the table is mirrored but this line has no mirror image (${key} is never listed)`);
    }
  }
  if (edges.length === 0) {
    throw new NativeParseError("edge-list", all.length, "the file holds no edges");
  }

  return { nodes: order.nodes(), edges };
}
