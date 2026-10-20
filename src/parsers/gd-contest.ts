import { NativeParseError } from "../errors";
import { lines, type NativeEdge, type NativeGraph, type NativeNode } from "./native";

const FORMAT = "gd-contest";

/** A value of the file and the 1-based line it is on. */
interface Token {
  readonly text: string;
  readonly line: number;
}

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[Ee][+-]?\d+)?$/;

/**
 * Reads a vertex number, which the format numbers from 0 to N - 1.
 * @param token - The token.
 * @param count - The declared vertex count.
 * @returns The vertex id as text.
 */
function vertex(token: Token, count: number): string {
  if (!/^(?:0|[1-9]\d*)$/.test(token.text) || Number(token.text) >= count) {
    throw new NativeParseError(FORMAT, token.line, `expected a vertex number from 0 to ${String(count - 1)}, found ${JSON.stringify(token.text)}`);
  }

  return token.text;
}

/**
 * Parses a Graph Drawing contest file (the `.gd4` format of the GD 2004 contest rules, http://vlado.fmf.uni-lj.si/pub/networks/data/GD/gd04/gd04.zip, `GD04/rules04.htm`) as a graph. The file is a sequence of values, with `#` starting a comment that runs to the end of its line: the vertex count N, then an X and a Y coordinate for each vertex in turn, then pairs of vertex numbers, one pair per undirected edge. Nodes are `0` to `N - 1`, isolated ones included, and edges are the pairs in file order. The coordinates are not carried: the rules give them as random starting positions for the contestants to move, not as data about the graph.
 * @param text - The file text.
 * @returns The native graph.
 * @throws NativeParseError naming the line for a missing or malformed vertex count, a coordinate that is not a number, too few coordinates, a vertex number outside 0 to N - 1, or an edge missing its second vertex.
 */
export function parseGdContest(text: string): NativeGraph {
  const tokens: Token[] = [];
  for (const [index, raw] of lines(text).entries()) {
    const comment = raw.indexOf("#");
    const content = comment === -1 ? raw : raw.slice(0, comment);
    for (const token of content.split(/\s+/).filter((part) => part !== "")) {
      tokens.push({ text: token, line: index + 1 });
    }
  }
  const [first] = tokens;
  if (first === undefined) {
    throw new NativeParseError(FORMAT, 1, "the file holds no vertex count");
  }
  if (!/^(?:0|[1-9]\d*)$/.test(first.text)) {
    throw new NativeParseError(FORMAT, first.line, `the vertex count must be a non-negative integer, found ${JSON.stringify(first.text)}`);
  }
  const count = Number(first.text);
  const coordinates = tokens.slice(1, 1 + 2 * count);
  if (coordinates.length < 2 * count) {
    throw new NativeParseError(FORMAT, lines(text).length, `expected ${String(2 * count)} coordinates for ${String(count)} vertices, found ${String(coordinates.length)}`);
  }
  for (const coordinate of coordinates) {
    if (!NUMBER.test(coordinate.text)) {
      throw new NativeParseError(FORMAT, coordinate.line, `coordinate ${JSON.stringify(coordinate.text)} is not a number`);
    }
  }
  const ends = tokens.slice(1 + 2 * count);
  const edges: NativeEdge[] = [];
  for (let source = ends.shift(); source !== undefined; source = ends.shift()) {
    const target = ends.shift();
    if (target === undefined) {
      throw new NativeParseError(FORMAT, source.line, `edge from vertex ${source.text} has no second vertex`);
    }
    edges.push({ source: vertex(source, count), target: vertex(target, count) });
  }
  const nodes: NativeNode[] = Array.from({ length: count }, (_, id) => ({ id: String(id) }));

  return { nodes, edges };
}
