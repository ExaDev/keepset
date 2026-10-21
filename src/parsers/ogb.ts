import { NativeParseError } from "../errors";
import { forEachLine, type NativeEdge, type NativeGraph, type NativeNode } from "./native";

const FORMAT = "ogb";

/** One file of an OGB dataset directory: its path in the archive and its text, decoded in pieces each time it is asked for, so an edge file longer than the engine's longest string is still read. */
export interface OgbFile {
  readonly path: string;
  readonly text: () => Iterable<string>;
}

/** The files of an OGB raw directory this reader takes, by their path under the dataset's root directory. A relation's files sit in `raw/relations/<head>___<relation>___<tail>/`. */
const RAW = /^(?<root>(?:[^/]+\/)*?)raw\/(?<name>num-node-list|num-node-dict|edge|num-edge-list|triplet-type-list|relations\/[^/]+\/(?:edge|num-edge-list))\.csv\.gz$/u;

const INDEX = /^(?:0|[1-9]\d*)$/;

/** The fields of a line of `triplet-type-list.csv.gz`: a head type, a relation and a tail type. */
const TRIPLET_PARTS = 3;

/**
 * Orders two names by code point, the order Python's `sorted` gives the ASCII type and relation names OGB uses.
 * @param left - A name.
 * @param right - Another.
 * @returns Negative, zero or positive.
 */
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** A non-blank line of a file and its 1-based number. */
interface Row {
  readonly text: string;
  readonly line: number;
}

/**
 * Visits the non-blank lines of a file, read a piece at a time.
 * @param file - The file.
 * @param visit - Called with each non-blank line and its number.
 */
function forEachRow(file: OgbFile, visit: (row: Row) => void): void {
  forEachLine(file.text(), (text, line) => {
    if (text.trim() !== "") {
      visit({ text, line });
    }
  });
}

/**
 * The non-blank lines of a small file, such as a count or the triplet list.
 * @param file - The file.
 * @returns Each non-blank line and its number.
 */
function rows(file: OgbFile): Row[] {
  const all: Row[] = [];
  forEachRow(file, (row) => {
    all.push(row);
  });

  return all;
}

/**
 * Reads a file that holds one line, such as a count.
 * @param file - The file.
 * @returns The line's text.
 * @throws NativeParseError when the file holds no line or more than one.
 */
function onlyLine(file: OgbFile): string {
  const all = rows(file);
  const [only] = all;
  if (all.length !== 1 || only === undefined) {
    throw new NativeParseError(FORMAT, all[1]?.line ?? 1, `${file.path} must hold one line, found ${String(all.length)}`);
  }

  return only.text.trim();
}

/**
 * Reads a non-negative integer.
 * @param text - The field.
 * @param file - The file, for the error.
 * @param line - The 1-based line, for the error.
 * @returns The integer.
 * @throws NativeParseError when the field is not a non-negative integer.
 */
function index(text: string, file: OgbFile, line: number): number {
  const trimmed = text.trim();
  if (!INDEX.test(trimmed)) {
    throw new NativeParseError(FORMAT, line, `${file.path}: expected a non-negative integer, found ${JSON.stringify(text)}`);
  }

  return Number(trimmed);
}

/** The two ends of a relation's edges: how many nodes the source and target types have, and the node id of an index of each. */
interface EdgeEnds {
  readonly sources: number;
  readonly targets: number;
  readonly source: (index: number) => string;
  readonly target: (index: number) => string;
}

/**
 * Reads an `edge.csv.gz` file, one `<source>,<target>` pair of node indices per line, checking each index against its node type's count and the line count against the relation's `num-edge-list.csv.gz`.
 * @param edges - The edge file.
 * @param count - The relation's `num-edge-list.csv.gz`.
 * @param ends - The source and target node types' counts and how each index is named.
 * @param emit - Called with each edge, in file order, so a large file is never held twice.
 * @throws NativeParseError naming the file and line for a line that is not a pair of indices, an index outside its type's nodes, or a line count other than the recorded one.
 */
function readEdges(edges: OgbFile, count: OgbFile, ends: EdgeEnds, emit: (edge: NativeEdge) => void): void {
  const recorded = index(onlyLine(count), count, 1);
  let read = 0;
  forEachRow(edges, ({ text, line }) => {
    const fields = text.split(",");
    const [first, second] = fields;
    if (fields.length !== 2 || first === undefined || second === undefined) {
      throw new NativeParseError(FORMAT, line, `${edges.path}: expected a source and a target index, found ${JSON.stringify(text)}`);
    }
    const source = index(first, edges, line);
    const target = index(second, edges, line);
    if (source >= ends.sources || target >= ends.targets) {
      throw new NativeParseError(FORMAT, line, `${edges.path}: edge ${text} names a node outside the ${String(ends.sources)} sources and ${String(ends.targets)} targets the dataset records`);
    }
    emit({ source: ends.source(source), target: ends.target(target) });
    read += 1;
  });
  if (read !== recorded) {
    throw new NativeParseError(FORMAT, read, `${edges.path} holds ${String(read)} edges, but ${count.path} records ${String(recorded)}`);
  }
}

/**
 * Takes one file of the dataset directory by its name under `raw/`.
 * @param files - The files by name.
 * @param name - The name, such as `edge` or `relations/paper___cites___paper/edge`.
 * @param root - The dataset's root directory, for the error.
 * @returns The file.
 * @throws NativeParseError when the archive's selection holds no such file.
 */
function required(files: ReadonlyMap<string, OgbFile>, name: string, root: string): OgbFile {
  const file = files.get(name);
  if (file === undefined) {
    throw new NativeParseError(FORMAT, 1, `the dataset directory ${root} has no raw/${name}.csv.gz among the files the recipe selects`);
  }

  return file;
}

/**
 * Parses an Open Graph Benchmark dataset from the files of its raw directory, as OGB's own `read_csv_graph_raw` and `read_csv_heterograph_raw` read them (ogb/io/read_graph_raw.py in snap-stanford/ogb). A homogeneous dataset has `raw/num-node-list.csv.gz` (its one graph's node count), `raw/edge.csv.gz` (one `<source>,<target>` pair of node indices per line, no header) and `raw/num-edge-list.csv.gz`: its nodes are `0` to `N - 1`, isolated ones included, and its edges the pairs in file order. A heterogeneous dataset has `raw/num-node-dict.csv.gz` (a header of node types over one row of their counts), `raw/triplet-type-list.csv.gz` (one `<head>,<relation>,<tail>` type triplet per line) and, per triplet, `raw/relations/<head>___<relation>___<tail>/edge.csv.gz` and `num-edge-list.csv.gz`, whose indices count within the head and tail types: its nodes are `<type>:<index>` for each type in sorted order and each index from 0, and its edges are each relation's pairs in file order, relations in the sorted order of their triplets, which is the order OGB reads them in. Edges keep the file's direction. Relation names, node features, labels and splits are not carried, as no graph parser in this version carries more than topology.
 * @param files - The files the recipe's archive selects, gunzipped and decoded: every one must be a file of one dataset's raw directory named above.
 * @returns The native graph.
 * @throws NativeParseError naming the file and line for a file outside the raw layout, files of two datasets, a dataset with neither or both node-count files, a missing file, a graph count other than one, a malformed count or triplet, a relation directory the triplet list does not name, an edge that is not a pair of indices of the dataset's nodes, or an edge file whose line count differs from its recorded count.
 */
export function parseOgb(files: readonly OgbFile[]): NativeGraph {
  const byName = new Map<string, OgbFile>();
  const roots = new Set<string>();
  for (const file of files) {
    const match = RAW.exec(file.path);
    const name = match?.groups?.["name"];
    const root = match?.groups?.["root"];
    if (name === undefined || root === undefined) {
      throw new NativeParseError(FORMAT, 1, `${file.path} is not a file of an OGB raw directory this reader takes`);
    }
    roots.add(root);
    byName.set(name, file);
  }
  const [root] = roots;
  if (roots.size !== 1 || root === undefined) {
    throw new NativeParseError(FORMAT, 1, `the recipe must select the raw files of one dataset, found ${roots.size === 0 ? "none" : `the directories ${[...roots].join(", ")}`}`);
  }
  const homogeneous = byName.get("num-node-list");
  const heterogeneous = byName.get("num-node-dict");
  const neitherOrBoth = `the dataset directory ${root} must have exactly one of raw/num-node-list.csv.gz (one node type) and raw/num-node-dict.csv.gz (several)`;
  const edges: NativeEdge[] = [];
  if (homogeneous !== undefined) {
    if (heterogeneous !== undefined) {
      throw new NativeParseError(FORMAT, 1, neitherOrBoth);
    }
    const [relation] = [...byName.keys()].filter((name) => name.startsWith("relations/"));
    if (relation !== undefined || byName.has("triplet-type-list")) {
      throw new NativeParseError(FORMAT, 1, `the dataset directory ${root} has raw/num-node-list.csv.gz, so it has one node type, but the recipe selects ${relation === undefined ? "raw/triplet-type-list.csv.gz" : `raw/${relation}.csv.gz`} as well`);
    }
    const count = index(onlyLine(homogeneous), homogeneous, 1);
    const name = (node: number): string => String(node);
    readEdges(required(byName, "edge", root), required(byName, "num-edge-list", root), { sources: count, targets: count, source: name, target: name }, (edge) => {
      edges.push(edge);
    });
    const nodes: NativeNode[] = Array.from({ length: count }, (_, node) => ({ id: String(node) }));

    return { nodes, edges };
  }
  if (heterogeneous === undefined) {
    throw new NativeParseError(FORMAT, 1, neitherOrBoth);
  }
  for (const stray of ["edge", "num-edge-list"]) {
    if (byName.has(stray)) {
      throw new NativeParseError(FORMAT, 1, `the dataset directory ${root} has raw/num-node-dict.csv.gz, so its edges are in raw/relations/, but the recipe selects raw/${stray}.csv.gz as well`);
    }
  }
  const header = rows(heterogeneous);
  const [types, counts] = header;
  if (header.length !== 2 || types === undefined || counts === undefined) {
    throw new NativeParseError(FORMAT, header[2]?.line ?? 1, `${heterogeneous.path} must hold a header of node types and one row of their counts, found ${String(header.length)} lines`);
  }
  const typeNames = types.text.split(",").map((type) => type.trim());
  const typeCounts = counts.text.split(",");
  if (typeNames.length !== typeCounts.length || typeNames.some((type) => type === "") || new Set(typeNames).size !== typeNames.length) {
    throw new NativeParseError(FORMAT, counts.line, `${heterogeneous.path} must name each node type once, over one count per type`);
  }
  const nodeTypes = typeNames.map((type, position) => {
    const count = typeCounts[position];
    if (count === undefined) {
      // The lengths were checked equal above, so every type has a count.
      throw new NativeParseError(FORMAT, counts.line, `${heterogeneous.path} gives node type ${type} no count`);
    }

    return { type, count: index(count, heterogeneous, counts.line) };
  });
  // OGB orders node types and relation triplets by sorting them (read_csv_heterograph_raw), so the graph does not depend on the order the files list them in.
  nodeTypes.sort((left, right) => compare(left.type, right.type));
  const nodeCounts = new Map(nodeTypes.map(({ type, count }) => [type, count]));
  const triplets = required(byName, "triplet-type-list", root);
  const relations: { readonly head: string; readonly relation: string; readonly tail: string; readonly sources: number; readonly targets: number }[] = [];
  for (const { text, line } of rows(triplets)) {
    const parts = text.split(",").map((part) => part.trim());
    const [head, relation, tail] = parts;
    if (parts.length !== TRIPLET_PARTS || head === undefined || relation === undefined || tail === undefined || relation === "") {
      throw new NativeParseError(FORMAT, line, `${triplets.path}: expected a head type, a relation and a tail type, found ${JSON.stringify(text)}`);
    }
    const sources = nodeCounts.get(head);
    const targets = nodeCounts.get(tail);
    if (sources === undefined || targets === undefined) {
      throw new NativeParseError(FORMAT, line, `${triplets.path}: ${text} names a node type that ${heterogeneous.path} does not count`);
    }
    relations.push({ head, relation, tail, sources, targets });
  }
  relations.sort((left, right) => compare(left.head, right.head) || compare(left.relation, right.relation) || compare(left.tail, right.tail));
  const listed = new Set(relations.map(({ head, relation, tail }) => `relations/${head}___${relation}___${tail}`));
  for (const name of byName.keys()) {
    const directory = name.slice(0, name.lastIndexOf("/"));
    if (name.startsWith("relations/") && !listed.has(directory)) {
      throw new NativeParseError(FORMAT, 1, `raw/${directory}/ is not one of the relations ${triplets.path} lists`);
    }
  }
  for (const { head, relation, tail, sources, targets } of relations) {
    const directory = `relations/${head}___${relation}___${tail}`;
    readEdges(required(byName, `${directory}/edge`, root), required(byName, `${directory}/num-edge-list`, root), { sources, targets, source: (node) => `${head}:${String(node)}`, target: (node) => `${tail}:${String(node)}` }, (edge) => {
      edges.push(edge);
    });
  }
  const nodes: NativeNode[] = nodeTypes.flatMap(({ type, count }) => Array.from({ length: count }, (_, node) => ({ id: `${type}:${String(node)}` })));

  return { nodes, edges };
}
