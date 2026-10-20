import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import { forEachLine, NodeOrder, type NativeEdge, type NativeGraph } from "./native";

type KonectParser = Extract<Parser, { format: "konect" }>;

const FORMAT = "konect";

/** The network formats of KONECT's first line (Kunegis, "The KONECT Handbook", table 1): undirected, directed and bipartite. */
const NETWORK_FORMATS: ReadonlySet<string> = new Set(["sym", "asym", "bip"]);

/** The weight types whose edges carry no weight: a third column, where the file has one, counts the edge's repetitions and is 1 for a single edge. */
const UNWEIGHTED_TYPES: ReadonlySet<string> = new Set(["unweighted", "positive"]);

/** The weight types whose third column is the edge's weight (handbook table 2). `dynamic` is not among them: its third column is +1 for an added edge and -1 for a removed one, which is not a weight. */
const WEIGHTED_TYPES: ReadonlySet<string> = new Set(["posweighted", "signed", "multisigned", "weighted", "multiweighted", "multiposweighted"]);

/** The first line, `% FORMAT WEIGHTS`. */
const FORMAT_LINE = /^%\s+(\S+)\s+(\S+)\s*$/;

/** The optional second line, `% EDGES SUBJECTS OBJECTS`: the number of edges and the number of nodes in each of the two sets (equal in a network that is not bipartite). */
const COUNT_LINE = /^%\s+(\d+)\s+(\d+)\s+(\d+)\s*$/;

/** A node id: KONECT numbers nodes from 1. */
const NODE_ID = /^[1-9]\d*$/;

/** A number as a decimal literal with an optional sign and exponent, so `Number` cannot read hex, an empty string or infinity. */
const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** The columns of an edge line (handbook section 9.1): the two nodes, then optionally the weight, and the time only when the weight is also given. */
const ENDPOINT_COLUMNS = 2;
const WEIGHTED_COLUMNS = 3;
const TIMESTAMPED_COLUMNS = 4;

/** The prefix of the node ids in a bipartite network's left and right set, whose numbering each starts from 1. */
const LEFT_PREFIX = "l:";
const RIGHT_PREFIX = "r:";

/** What the leading comment lines declare, and the line the first of them is on. */
interface Header {
  readonly line: number;
  readonly network: string;
  readonly counts?: { readonly edges: number; readonly left: number; readonly right: number };
}

/** The parse so far. A header assigned inside the line visitor is held in an object, so that reading it afterwards is not narrowed to the value it had before the visitor ran. */
interface State {
  header?: Header;
}

/**
 * Parses a KONECT TSV file (`out.<network>` in a KONECT download, in the format of section 9.1 of the KONECT Handbook, Kunegis 2017): a first line `% FORMAT WEIGHTS`, an optional second line `% EDGES SUBJECTS OBJECTS`, then one edge per line as two to four whitespace-separated numbers, the source node, the target node, the weight and the time. Other `%` lines are comments.
 *
 * Nodes are the endpoints in order of first appearance, as they are numbered in the file, except in a bipartite network, whose two node sets are numbered independently from 1: there a left node is `l:<n>` and a right node `r:<n>`, so left node 1 and right node 1 are two nodes. Edges are in file order. An edge carries `weight` when the recipe says the file's weights are read, and `timestamp` when it says the file has a time column. The recipe's `weighted` must agree with the file's weight type (`posweighted`, `signed`, `weighted` and their multi-edge forms are weighted; `unweighted` and `positive` are not, and an edge's repetition count in their third column must be 1) and `timestamped` with the file having four columns, so a recipe cannot silently drop a weight or a time the file holds. When the second line is present, its edge count must equal the number of edge lines and every node id must lie within its declared set.
 * @param pieces - The file's text, in order.
 * @param options - The recipe's parser.
 * @returns The native graph.
 * @throws NativeParseError naming the line for a missing or unknown first line, a `dynamic` network, a recipe that disagrees with the file, a malformed edge line, a node id out of its declared range, an edge count that differs from the declared one, and when the file holds no edges.
 */
export function parseKonect(pieces: Readonly<Iterable<string>>, options: Readonly<KonectParser>): NativeGraph {
  const order = new NodeOrder();
  const edges: NativeEdge[] = [];
  const state: State = {};
  let lastLine = 0;
  forEachLine(pieces, (line, number) => {
    lastLine = number;
    const content = line.trim();
    if (content === "") {
      return;
    }
    const { header } = state;
    if (header === undefined) {
      state.header = readHeader(content, number, options);

      return;
    }
    if (content.startsWith("%")) {
      const counts = number === header.line + 1 ? COUNT_LINE.exec(content) : null;
      if (counts?.[1] !== undefined && counts[2] !== undefined && counts[3] !== undefined) {
        state.header = { ...header, counts: { edges: Number(counts[1]), left: Number(counts[2]), right: Number(counts[3]) } };
      }

      return;
    }
    edges.push(readEdge(content, number, { header, options, order }));
  });
  const { header } = state;
  if (header === undefined) {
    throw new NativeParseError(FORMAT, lastLine, "the file has no first line naming its format and weights");
  }
  if (edges.length === 0) {
    throw new NativeParseError(FORMAT, lastLine, "the file holds no edges");
  }
  if (header.counts !== undefined && header.counts.edges !== edges.length) {
    throw new NativeParseError(FORMAT, lastLine, `the second line declares ${String(header.counts.edges)} edges, the file holds ${String(edges.length)}`);
  }

  return { nodes: order.nodes(), edges };
}

/**
 * Reads the first line and checks the recipe against it.
 * @param content - The trimmed first non-blank line.
 * @param number - Its 1-based number.
 * @param options - The recipe's parser.
 * @returns The format and weight type it declares.
 * @throws NativeParseError when it is not `% FORMAT WEIGHTS` with a known format, when the network is dynamic, or when the recipe's `weighted` disagrees with the weight type.
 */
function readHeader(content: string, number: number, options: Readonly<KonectParser>): Header {
  const match = FORMAT_LINE.exec(content);
  const network = match?.[1];
  const weights = match?.[2];
  if (network === undefined || weights === undefined || !NETWORK_FORMATS.has(network)) {
    throw new NativeParseError(FORMAT, number, `expected a first line "% FORMAT WEIGHTS" with FORMAT one of ${[...NETWORK_FORMATS].join(", ")}, found ${JSON.stringify(content)}`);
  }
  if (!WEIGHTED_TYPES.has(weights) && !UNWEIGHTED_TYPES.has(weights)) {
    throw new NativeParseError(FORMAT, number, `the weight type ${JSON.stringify(weights)} is not one this parser reads (its third column is not an edge weight or a repetition count)`);
  }
  if (options.weighted !== WEIGHTED_TYPES.has(weights)) {
    throw new NativeParseError(FORMAT, number, `the file's weight type is ${weights}, so a recipe with weighted ${String(WEIGHTED_TYPES.has(weights))} reads it, not one with weighted ${String(options.weighted)}`);
  }

  return { line: number, network };
}

/**
 * Reads one edge line.
 * @param content - The trimmed line.
 * @param number - Its 1-based number.
 * @param context - What the first lines declare (`header`), the recipe's parser (`options`) and the `order` that receives the edge's endpoints.
 * @returns The edge.
 * @throws NativeParseError when the line has the wrong number of columns, a node id that is not a positive integer or is outside its declared set, a weight or time that is not a number, or a repetition count other than 1.
 */
function readEdge(content: string, number: number, context: Readonly<{ header: Header; options: Readonly<KonectParser>; order: NodeOrder }>): NativeEdge {
  const { header, options, order } = context;
  const fields = content.split(/\s+/);
  const [from, to, third, time] = fields;
  // A recipe that reads a time needs the weight column before it, and one that reads a weight needs it present; without either, the column is optional and only a repetition count of 1 is read.
  const expected = options.timestamped ? TIMESTAMPED_COLUMNS : options.weighted ? WEIGHTED_COLUMNS : undefined;
  const fits = expected === undefined ? fields.length === ENDPOINT_COLUMNS || fields.length === WEIGHTED_COLUMNS : fields.length === expected;
  if (from === undefined || to === undefined || !fits) {
    throw new NativeParseError(FORMAT, number, `expected ${expected === undefined ? `${String(ENDPOINT_COLUMNS)} or ${String(WEIGHTED_COLUMNS)}` : String(expected)} columns for this recipe, found ${String(fields.length)}`);
  }
  const bipartite = header.network === "bip";
  const source = endpoint(from, bipartite ? LEFT_PREFIX : "", header.counts?.left, number);
  const target = endpoint(to, bipartite ? RIGHT_PREFIX : "", header.counts?.right, number);
  order.add(source);
  order.add(target);
  if (third !== undefined && !options.weighted && (!DECIMAL.test(third) || Number(third) !== 1)) {
    throw new NativeParseError(FORMAT, number, `the third column ${JSON.stringify(third)} is not 1; an edge that stands for several would be read as one`);
  }
  if (third !== undefined && options.weighted && !DECIMAL.test(third)) {
    throw new NativeParseError(FORMAT, number, `the weight ${JSON.stringify(third)} is not a number`);
  }
  if (time !== undefined && !DECIMAL.test(time)) {
    throw new NativeParseError(FORMAT, number, `the time ${JSON.stringify(time)} is not a number`);
  }
  const edge: { source: string; target: string; weight?: number; timestamp?: number } = { source, target };
  if (options.weighted && third !== undefined) {
    edge.weight = Number(third);
  }
  if (options.timestamped && time !== undefined) {
    edge.timestamp = Number(time);
  }

  return edge;
}

/**
 * Reads a node id.
 * @param token - The id as written.
 * @param prefix - The prefix of the node's set in a bipartite network, empty otherwise.
 * @param size - The declared size of the node's set, when the file declares one.
 * @param number - The 1-based line, for the error.
 * @returns The node id.
 * @throws NativeParseError when the token is not a positive integer or exceeds the set's size.
 */
function endpoint(token: string, prefix: string, size: number | undefined, number: number): string {
  if (!NODE_ID.test(token) || (size !== undefined && Number(token) > size)) {
    throw new NativeParseError(FORMAT, number, `${JSON.stringify(token)} is not a node id from 1${size === undefined ? "" : ` to ${String(size)}`}`);
  }

  return `${prefix}${token}`;
}
