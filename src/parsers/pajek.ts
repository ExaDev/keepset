import { NativeParseError } from "../errors";
import { lines, type NativeEdge, type NativeGraph, type NativeNode } from "./native";

/** The section a line belongs to. */
type Section = "preamble" | "vertices" | "pairs" | "lists" | "matrix" | "attributes";

/** Section keywords, lower-cased, mapped to how their lines are read. `*Network` names the network and starts no section. `*Partition` and `*Vector` hold node attributes this version does not carry, so their lines are skipped, as are the `*Vertices` lines inside them. */
const sections: ReadonlyMap<string, Section | "network"> = new Map([
  ["*network", "network"],
  ["*vertices", "vertices"],
  ["*arcs", "pairs"],
  ["*edges", "pairs"],
  ["*arcslist", "lists"],
  ["*edgeslist", "lists"],
  ["*matrix", "matrix"],
  ["*partition", "attributes"],
  ["*vector", "attributes"],
]);

/**
 * Resolves a section keyword, which Pajek reads case-insensitively and accepts abbreviated (`*net` for `*Network`, `*vert` for `*Vertices`): an exact keyword first, otherwise the shortest keyword it abbreviates, so `*edge` is `*Edges` rather than `*Edgeslist`.
 * @param keyword - The keyword as written.
 * @returns How its section is read, or undefined for a keyword that abbreviates none.
 */
function sectionOf(keyword: string): Section | "network" | undefined {
  const name = keyword.toLowerCase();
  const exact = sections.get(name);
  if (exact !== undefined) {
    return exact;
  }
  const [shortest] = [...sections.keys()].filter((candidate) => candidate.startsWith(name)).sort((left, right) => left.length - right.length);

  return shortest === undefined ? undefined : sections.get(shortest);
}

/**
 * Reads a vertex number, which Pajek numbers from 1 to the declared vertex count.
 * @param token - The token.
 * @param count - The declared vertex count.
 * @param line - The 1-based line, for the error.
 * @returns The vertex id as text.
 */
function vertex(token: string | undefined, count: number, line: number): string {
  if (token === undefined || !/^[1-9]\d*$/.test(token) || Number(token) > count) {
    throw new NativeParseError("pajek", line, `expected a vertex number from 1 to ${String(count)}, found ${JSON.stringify(token)}`);
  }

  return token;
}

/**
 * Parses a Pajek network (`.net`, or the first network of a `.paj` project, in the format the Pajek manual by Batagelj and Mrvar describes) as a graph. Nodes are `1` to `n` from `*Vertices n`, isolated ones included. Edges come from `*Arcs` and `*Edges` pairs, `*Arcslist` and `*Edgeslist` adjacency lists, and `*Matrix` rows (a non-zero cell is an edge; in a two-mode network, `*Vertices n n1`, rows are the first n1 vertices and columns the rest), in file order. Weights, labels and coordinates are not carried in this version.
 * @param text - The file text.
 * @returns The native graph.
 * @throws NativeParseError naming the line for data before `*Vertices`, a vertex number outside the declared range, a malformed matrix row, an unknown section, or a second network in a project file.
 */
export function parsePajek(text: string): NativeGraph {
  let count: number | undefined;
  let firstMode: number | undefined;
  let section: Section = "preamble";
  let matrixRow = 0;
  let networks = 0;
  const edges: NativeEdge[] = [];
  for (const [index, raw] of lines(text).entries()) {
    const lineNumber = index + 1;
    const content = raw.trim();
    if (content === "" || content.startsWith("%")) {
      continue;
    }
    const tokens = content.split(/\s+/);
    const [keyword] = tokens;
    if (keyword?.startsWith("*") === true) {
      const next = sectionOf(keyword);
      if (next === undefined) {
        throw new NativeParseError("pajek", lineNumber, `unknown section ${keyword}`);
      }
      if (next === "network") {
        networks++;
        if (networks > 1) {
          throw new NativeParseError("pajek", lineNumber, "a project file holding more than one network is not supported");
        }
        continue;
      }
      // A partition's or vector's own *Vertices line belongs to that attribute block, not to the network.
      if (next === "vertices" && section !== "attributes") {
        if (count !== undefined) {
          throw new NativeParseError("pajek", lineNumber, "a network declares *Vertices twice");
        }
        const declared = tokens[1];
        if (declared === undefined || !/^\d+$/.test(declared)) {
          throw new NativeParseError("pajek", lineNumber, "*Vertices must give the vertex count");
        }
        count = Number(declared);
        const mode = tokens[2];
        firstMode = mode === undefined ? undefined : Number(vertex(mode, count, lineNumber));
        section = "vertices";
      } else if (next !== "vertices") {
        section = next;
      }
      matrixRow = 0;
      continue;
    }
    if (section === "attributes" || section === "vertices") {
      continue;
    }
    if (count === undefined) {
      throw new NativeParseError("pajek", lineNumber, "data before *Vertices");
    }
    if (section === "preamble") {
      throw new NativeParseError("pajek", lineNumber, "data outside any section");
    }
    if (section === "pairs") {
      edges.push({ source: vertex(tokens[0], count, lineNumber), target: vertex(tokens[1], count, lineNumber) });
    } else if (section === "lists") {
      const source = vertex(tokens[0], count, lineNumber);
      for (const target of tokens.slice(1)) {
        edges.push({ source, target: vertex(target, count, lineNumber) });
      }
    } else {
      const rows = firstMode ?? count;
      const columnOffset = firstMode ?? 0;
      const columns = count - columnOffset;
      matrixRow++;
      if (matrixRow > rows || tokens.length !== columns) {
        throw new NativeParseError("pajek", lineNumber, `expected ${String(rows)} matrix rows of ${String(columns)} cells`);
      }
      for (const [column, cell] of tokens.entries()) {
        if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[Ee][+-]?\d+)?$/.test(cell)) {
          throw new NativeParseError("pajek", lineNumber, `matrix cell ${JSON.stringify(cell)} is not a number`);
        }
        if (Number(cell) !== 0) {
          edges.push({ source: String(matrixRow), target: String(columnOffset + column + 1) });
        }
      }
    }
  }
  if (count === undefined) {
    throw new NativeParseError("pajek", lines(text).length, "the file declares no *Vertices");
  }
  const nodes: NativeNode[] = [];
  for (let id = 1; id <= count; id++) {
    nodes.push({ id: String(id) });
  }

  return { nodes, edges };
}
