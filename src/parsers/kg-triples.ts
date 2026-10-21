import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import { forEachLine, NodeOrder, type NativeNode, type NativeSplitEdge, type NativeTypedEdge } from "./native";

type KgTriplesParser = Extract<Parser, { format: "kg-triples" }>;

const FORMAT = "kg-triples";

/** The character each delimiter option splits a line on. A line is split on exactly that character, so a field cannot hide a second delimiter. */
const DELIMITERS: Readonly<Record<KgTriplesParser["delimiter"], string>> = { tab: "\t", space: " " };

/** The fields of a triple line: the head, the relation and the tail, in one of two orders. */
const TRIPLE_FIELDS = 3;

/** A count line: a non-negative decimal integer with no sign or leading zero. */
const COUNT = /^(?:0|[1-9]\d*)$/;

/** The double quote that wraps every field of a quoted file. */
const QUOTE = '"';

/** Where a field is: its 1-based line, and the part's split name and a colon, or nothing for a single file. */
interface Where {
  readonly line: number;
  readonly part: string;
}

/** One file of a triples download: the name of the split it holds (`train`, `valid`, `test`), when the recipe reads several, and its text in pieces. */
export interface TriplesPart {
  readonly split: string | undefined;
  readonly pieces: Readonly<Iterable<string>>;
}

/**
 * Reads one field: unwraps the quotes of a quoted file, and refuses an empty field.
 * @param field - The field as the line has it.
 * @param quoted - Whether every field of the file is wrapped in double quotes.
 * @param where - Where the field is, for the error.
 * @returns The field's value.
 * @throws NativeParseError for an empty field, or in a quoted file a field not wrapped in quotes or holding one.
 */
function value(field: string, quoted: boolean, where: Where): string {
  const inner = quoted ? field.slice(1, -1) : field;
  if (quoted && (field.length < 2 || !field.startsWith(QUOTE) || !field.endsWith(QUOTE) || inner.includes(QUOTE))) {
    throw new NativeParseError(FORMAT, where.line, `${where.part}the field ${JSON.stringify(field)} is not one value wrapped in double quotes`);
  }
  if (inner === "") {
    throw new NativeParseError(FORMAT, where.line, `${where.part}a field is empty`);
  }

  return inner;
}

/**
 * Parses knowledge graph triple files into one graph: each line of each part is one triple, a head, a relation and a tail separated by the recipe's delimiter, in the recipe's field order. The part's first line is a triple, a header naming the columns (skipped), or the number of triples the part holds (checked), as the recipe's `header` says.
 *
 * Nodes are the heads and tails, in order of first appearance across the parts in the order given, with no type: the files type their relations, not their entities. Every line is an edge from its head to its tail, in part order then file order, with `type` the relation as written; a triple that appears twice is two edges. When the parts carry split names, each edge's `split` is the name of the part it came from; a single file has no split and its edges carry none.
 * @param parts - The files, in the order the recipe names them: every one named by its split, or a single file with none.
 * @param options - The recipe's parser.
 * @returns The native graph.
 * @throws NativeParseError naming the part and line for a line without exactly three fields, an empty or wrongly quoted field, a blank line, a count line that is not a count or differs from the part's triples, and a part with no triples.
 */
export function parseKgTriples(parts: readonly TriplesPart[], options: Readonly<KgTriplesParser>): { readonly nodes: readonly NativeNode[]; readonly edges: readonly (NativeTypedEdge | NativeSplitEdge)[] } {
  const delimiter = DELIMITERS[options.delimiter];
  const order = new NodeOrder();
  // Relation names repeat on almost every line and there are few of them, so each edge points at one shared string instead of a slice of its own line.
  const relations = new Map<string, string>();
  const edges: (NativeTypedEdge | NativeSplitEdge)[] = [];
  for (const part of parts) {
    const label = part.split === undefined ? "" : `${part.split}: `;
    let declared: number | undefined;
    let triples = 0;
    let lastLine = 0;
    forEachLine(part.pieces, (line, number) => {
      lastLine = number;
      if (line.trim() === "") {
        throw new NativeParseError(FORMAT, number, `${label}the line is blank`);
      }
      if (number === 1 && options.header === "names") {
        return;
      }
      if (number === 1 && options.header === "count") {
        if (!COUNT.test(line)) {
          throw new NativeParseError(FORMAT, number, `${label}expected the number of triples on the first line, found ${JSON.stringify(line)}`);
        }
        declared = Number(line);

        return;
      }
      const fields = line.split(delimiter);
      const [head, middle, last] = fields;
      if (fields.length !== TRIPLE_FIELDS || head === undefined || middle === undefined || last === undefined) {
        throw new NativeParseError(FORMAT, number, `${label}expected ${String(TRIPLE_FIELDS)} fields separated by ${options.delimiter}, found ${String(fields.length)}`);
      }
      const where = { line: number, part: label };
      const [relationField, tailField] = options.order === "head-relation-tail" ? [middle, last] : [last, middle];
      const source = order.intern(value(head, options.quoted, where));
      const relation = value(relationField, options.quoted, where);
      const target = order.intern(value(tailField, options.quoted, where));
      let type = relations.get(relation);
      if (type === undefined) {
        type = relation;
        relations.set(relation, relation);
      }
      edges.push(part.split === undefined ? { source, target, type } : { source, target, type, split: part.split });
      triples += 1;
    });
    if (triples === 0) {
      throw new NativeParseError(FORMAT, lastLine, `${label}the file holds no triples`);
    }
    if (declared !== undefined && declared !== triples) {
      throw new NativeParseError(FORMAT, lastLine, `${label}the first line declares ${String(declared)} triples, the file holds ${String(triples)}`);
    }
  }

  return { nodes: order.nodes(), edges };
}
