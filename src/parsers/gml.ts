import { NativeParseError } from "../errors";
import type { NativeEdge, NativeGraph, NativeNode } from "./native";

/** A GML value: a number or string kept as its source text, or a nested list of key-value pairs. */
type GmlValue = { readonly kind: "scalar"; readonly text: string; readonly line: number } | { readonly kind: "list"; readonly pairs: readonly GmlPair[]; readonly line: number };

interface GmlPair {
  readonly key: string;
  readonly value: GmlValue;
}

interface Token {
  readonly kind: "key" | "scalar" | "open" | "close";
  readonly text: string;
  readonly line: number;
}

// Sticky, so each match is anchored at the scan position without slicing the text.
const KEY = /[A-Za-z_][A-Za-z0-9_]*/y;
const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[Ee][+-]?\d+)?/y;

/**
 * Matches a sticky pattern at a position.
 * @param pattern - A sticky regular expression.
 * @param text - The text.
 * @param position - Where the match must start.
 * @returns The matched text, or undefined when the pattern does not match there.
 */
function matchAt(pattern: Readonly<RegExp>, text: string, position: number): string | undefined {
  // A fresh sticky copy per call, so the shared pattern's lastIndex is never mutated.
  const sticky = new RegExp(pattern.source, "y");
  sticky.lastIndex = position;

  return sticky.exec(text)?.[0];
}

/**
 * Splits GML text into tokens: keys, numbers, double-quoted strings (which GML lets span lines and never escapes) and brackets, skipping whitespace and `#` comment lines. One pass over the text, by position.
 * @param text - The file text.
 * @returns The tokens with their 1-based lines.
 */
function tokenise(text: string): Token[] {
  const tokens: Token[] = [];
  let line = 1;
  let position = 0;
  while (position < text.length) {
    const char = text.charAt(position);
    if (char === "\n") {
      line++;
      position++;
    } else if (/\s/.test(char)) {
      position++;
    } else if (char === "#") {
      const end = text.indexOf("\n", position);
      position = end === -1 ? text.length : end;
    } else if (char === "[" || char === "]") {
      tokens.push({ kind: char === "[" ? "open" : "close", text: char, line });
      position++;
    } else if (char === '"') {
      const end = text.indexOf('"', position + 1);
      if (end === -1) {
        throw new NativeParseError("gml", line, "a string is never closed");
      }
      const body = text.slice(position + 1, end);
      tokens.push({ kind: "scalar", text: body, line });
      line += body.split("\n").length - 1;
      position = end + 1;
    } else {
      const key = matchAt(KEY, text, position);
      const number = key === undefined ? matchAt(NUMBER, text, position) : undefined;
      const match = key ?? number;
      if (match === undefined) {
        throw new NativeParseError("gml", line, `unexpected character ${JSON.stringify(char)}`);
      }
      tokens.push({ kind: key === undefined ? "scalar" : "key", text: match, line });
      position += match.length;
    }
  }

  return tokens;
}

/**
 * Parses tokens into key-value pairs until the end of input (at the top level) or a closing bracket (inside a list).
 * @param tokens - Every token.
 * @param start - The index to start at.
 * @param nested - Whether this list was opened by a bracket and must be closed by one.
 * @returns The pairs and the index after the list.
 */
function parsePairs(tokens: readonly Token[], start: number, nested: boolean): { pairs: GmlPair[]; next: number } {
  const pairs: GmlPair[] = [];
  let index = start;
  for (let token = tokens[index]; token !== undefined; token = tokens[index]) {
    if (token.kind === "close") {
      if (!nested) {
        throw new NativeParseError("gml", token.line, "a ']' closes no list");
      }

      return { pairs, next: index + 1 };
    }
    if (token.kind !== "key") {
      throw new NativeParseError("gml", token.line, `expected a key, found ${JSON.stringify(token.text)}`);
    }
    const value = tokens[index + 1];
    if (value === undefined) {
      throw new NativeParseError("gml", token.line, `key ${token.text} has no value`);
    }
    if (value.kind === "open") {
      const list = parsePairs(tokens, index + 2, true);
      pairs.push({ key: token.text, value: { kind: "list", pairs: list.pairs, line: value.line } });
      index = list.next;
    } else if (value.kind === "scalar") {
      pairs.push({ key: token.text, value: { kind: "scalar", text: value.text, line: value.line } });
      index += 2;
    } else {
      throw new NativeParseError("gml", value.line, `key ${token.text} has no value`);
    }
  }
  const last = tokens.at(-1);
  if (nested) {
    throw new NativeParseError("gml", last === undefined ? 1 : last.line, "a '[' is never closed");
  }

  return { pairs, next: index };
}

/**
 * Reads the one scalar a list holds under a key.
 * @param list - The list.
 * @param key - The key.
 * @param owner - What the list is, for the error.
 * @returns The scalar's text.
 */
function scalar(list: Extract<GmlValue, { kind: "list" }>, key: string, owner: string): string {
  const values = list.pairs.filter((pair) => pair.key === key).map((pair) => pair.value);
  const [value] = values;
  if (values.length !== 1 || value?.kind !== "scalar") {
    throw new NativeParseError("gml", list.line, `a ${owner} must hold exactly one scalar ${key}, found ${String(values.length)}`);
  }

  return value.text;
}

/**
 * Parses a GML file (the format of Michael Himsolt's "GML: A portable Graph File Format", Universität Passau) as a graph: the one top-level `graph` list, its `node` lists by `id` in file order and its `edge` lists by `source` and `target` in file order. Ids keep their source text, so `1` and `"1"` name the same node. Every other key (labels, values, graphics, `directed`) is not carried in this version.
 * @param text - The file text.
 * @returns The native graph.
 * @throws NativeParseError naming the line for a malformed file, a file without exactly one graph, or a node or edge without exactly one id, source or target.
 */
export function parseGml(text: string): NativeGraph {
  const { pairs } = parsePairs(tokenise(text), 0, false);
  const graphs = pairs.filter((pair) => pair.key === "graph").map((pair) => pair.value);
  const [graph] = graphs;
  if (graphs.length !== 1 || graph?.kind !== "list") {
    throw new NativeParseError("gml", 1, `the file must hold exactly one graph list, found ${String(graphs.length)}`);
  }
  const nodes: NativeNode[] = [];
  const edges: NativeEdge[] = [];
  for (const pair of graph.pairs) {
    if (pair.value.kind !== "list") {
      continue;
    }
    if (pair.key === "node") {
      nodes.push({ id: scalar(pair.value, "id", "node") });
    } else if (pair.key === "edge") {
      edges.push({ source: scalar(pair.value, "source", "edge"), target: scalar(pair.value, "target", "edge") });
    }
  }

  return { nodes, edges };
}
