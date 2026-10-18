import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import { lines, NodeOrder, type NativeEdge, type NativeGraph } from "./native";

type EdgeListParser = Extract<Parser, { format: "edge-list" }>;

/** How each delimiter option splits a line into fields. */
const splitters: Readonly<Record<EdgeListParser["delimiter"], (line: string) => string[]>> = {
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
 * Parses a delimited edge list: one edge per line, source and target in the configured columns, after `skipLines` header lines, with blank lines and lines whose first non-blank characters are a comment prefix skipped. Nodes are the endpoints, in order of first appearance.
 * @param text - The file text.
 * @param options - The recipe's edge-list parser.
 * @returns The native graph.
 * @throws NativeParseError naming the line when a data line has too few fields or an empty endpoint, or when the file holds no edges.
 */
export function parseEdgeList(text: string, options: EdgeListParser): NativeGraph {
  const split = splitters[options.delimiter];
  const needed = Math.max(options.sourceColumn, options.targetColumn) + 1;
  const order = new NodeOrder();
  const edges: NativeEdge[] = [];
  for (const [index, line] of lines(text).entries()) {
    const lineNumber = index + 1;
    const content = line.trimStart();
    if (index < options.skipLines || content === "" || options.commentPrefixes.some((prefix) => content.startsWith(prefix))) {
      continue;
    }
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
