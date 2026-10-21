import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import { forEachLine, type NativeTypedEdge, type NativeTypedNode } from "./native";

type HgbParser = Extract<Parser, { format: "hgb" }>;

const FORMAT = "hgb";

/** A type code or node id as the HGB files write them: a non-negative decimal integer with no sign or leading zero. */
const CODE = /^(?:0|[1-9]\d*)$/;

/** A number as a decimal literal with an optional sign and exponent, so `Number` cannot read hex, an empty string or infinity. */
const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** `node.dat` lines are the id, the name and the type, then the attributes on node types that have them. */
const NODE_FIELDS = 3;
const NODE_FIELDS_WITH_ATTRIBUTES = 4;

/** `link.dat` lines are the source, the target, the link type and the weight. */
const LINK_FIELDS = 4;

/** Where a field is: the file, its 1-based line, and which kind of type the field names, node or link. */
interface Where {
  readonly file: string;
  readonly line: number;
  readonly kind: string;
}

/** The two files of an HGB dataset, each as its text in pieces. */
export interface HgbParts {
  readonly nodes: Readonly<Iterable<string>>;
  readonly links: Readonly<Iterable<string>>;
}

/**
 * Reads a type code and resolves it against the types the recipe gives, in code order.
 * @param field - The field.
 * @param types - The recipe's types.
 * @param where - Where the field is, for the error.
 * @returns The type the code names.
 * @throws NativeParseError when the field is not a code or names no type of the recipe.
 */
function resolve<Type>(field: string, types: readonly Type[], where: Where): Type {
  const index = CODE.test(field) ? Number(field) : -1;
  const type = types[index];
  if (type === undefined) {
    throw new NativeParseError(FORMAT, where.line, `${where.file}: the ${where.kind} type ${JSON.stringify(field)} is not one of the ${String(types.length)} the recipe names`);
  }

  return type;
}

/**
 * Parses a Heterogeneous Graph Benchmark dataset (Lv et al., "Are we really making much progress? Revisiting, benchmarking, and refining heterogeneous graph neural networks", KDD 2021): `node.dat`, one node per line as `id<TAB>name<TAB>type`, with a fourth field of attributes on the node types that have them, and `link.dat`, one link per line as `source<TAB>target<TAB>type<TAB>weight`. The type codes number the types the recipe names, which are the ones the dataset's `info.dat` gives, in code order, each link type with the node types it runs from and to.
 *
 * Nodes are the lines of `node.dat` in file order, each with its id and `type` the name of its node type; names and attributes are not read. Edges are the lines of `link.dat` in file order, each from its source to its target with `type` the name of its link type. Every link's endpoints must be nodes of the node types its link type joins, and its weight must be 1, the only weight the benchmark's files hold, so the weight column carries nothing the graph drops.
 * @param parts - The two files.
 * @param options - The recipe's parser.
 * @returns The native graph.
 * @throws NativeParseError naming the file and line for a line with the wrong number of fields, an id that is not a code or repeats, a type code the recipe does not name, a link whose endpoint is not a node or is of another node type than its link type joins, a weight other than 1, and a file with no lines.
 */
export function parseHgb(parts: Readonly<HgbParts>, options: Readonly<HgbParser>): { readonly nodes: readonly NativeTypedNode[]; readonly edges: readonly NativeTypedEdge[] } {
  const nodes: NativeTypedNode[] = [];
  const typeOf = new Map<string, string>();
  forEachLine(parts.nodes, (line, number) => {
    const fields = line.split("\t");
    const [id, , type] = fields;
    if ((fields.length !== NODE_FIELDS && fields.length !== NODE_FIELDS_WITH_ATTRIBUTES) || id === undefined || type === undefined) {
      throw new NativeParseError(FORMAT, number, `node.dat: expected ${String(NODE_FIELDS)} or ${String(NODE_FIELDS_WITH_ATTRIBUTES)} fields separated by tabs, found ${String(fields.length)}`);
    }
    if (!CODE.test(id)) {
      throw new NativeParseError(FORMAT, number, `node.dat: the node id ${JSON.stringify(id)} is not a non-negative integer`);
    }
    if (typeOf.has(id)) {
      throw new NativeParseError(FORMAT, number, `node.dat: the node id ${id} is repeated`);
    }
    const nodeType = resolve(type, options.nodeTypes, { file: "node.dat", line: number, kind: "node" });
    typeOf.set(id, nodeType);
    nodes.push({ id, type: nodeType });
  });
  if (nodes.length === 0) {
    throw new NativeParseError(FORMAT, 1, "node.dat: the file holds no nodes");
  }
  const edges: NativeTypedEdge[] = [];
  forEachLine(parts.links, (line, number) => {
    const fields = line.split("\t");
    const [source, target, type, weight] = fields;
    if (fields.length !== LINK_FIELDS || source === undefined || target === undefined || type === undefined || weight === undefined) {
      throw new NativeParseError(FORMAT, number, `link.dat: expected ${String(LINK_FIELDS)} fields separated by tabs, found ${String(fields.length)}`);
    }
    const linkType = resolve(type, options.linkTypes, { file: "link.dat", line: number, kind: "link" });
    for (const [end, id, expected] of [
      ["source", source, linkType.source],
      ["target", target, linkType.target],
    ] as const) {
      const actual = typeOf.get(id);
      if (actual === undefined) {
        throw new NativeParseError(FORMAT, number, `link.dat: the ${end} ${JSON.stringify(id)} is not a node of node.dat`);
      }
      if (actual !== expected) {
        throw new NativeParseError(FORMAT, number, `link.dat: a ${linkType.name} link's ${end} must be a ${expected} node, and ${id} is a ${actual} node`);
      }
    }
    if (!DECIMAL.test(weight) || Number(weight) !== 1) {
      throw new NativeParseError(FORMAT, number, `link.dat: the weight ${JSON.stringify(weight)} is not 1; a weighted HGB file would lose its weights`);
    }
    edges.push({ source, target, type: linkType.name });
  });
  if (edges.length === 0) {
    throw new NativeParseError(FORMAT, 1, "link.dat: the file holds no links");
  }

  return { nodes, edges };
}
