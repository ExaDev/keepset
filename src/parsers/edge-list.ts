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
 * Parses a delimited edge list: one edge per line, source and target in the configured columns, after `skipLines` header lines, with blank lines and lines whose first non-blank characters are a comment prefix skipped. A `detect` delimiter is fixed from the first data line. Nodes are the endpoints, in order of first appearance.
 * @param text - The file text.
 * @param options - The recipe's edge-list parser.
 * @returns The native graph.
 * @throws NativeParseError naming the line when a data line has too few fields or an empty endpoint, or when the file holds no edges.
 */
export function parseEdgeList(text: string, options: EdgeListParser): NativeGraph {
  let split = options.delimiter === "detect" ? undefined : splitters[options.delimiter];
  const needed = Math.max(options.sourceColumn, options.targetColumn) + 1;
  const order = new NodeOrder();
  const edges: NativeEdge[] = [];
  for (const [index, line] of lines(text).entries()) {
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
    const source = endpoint(fields, options.sourceColumn, lineNumber);
    const target = endpoint(fields, options.targetColumn, lineNumber);
    order.add(source);
    order.add(target);
    edges.push({ source, target });
  }
  if (edges.length === 0) {
    throw new NativeParseError("edge-list", lines(text).length, "the file holds no edges");
  }

  return { nodes: order.nodes(), edges };
}
