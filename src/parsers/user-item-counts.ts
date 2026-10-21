import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import { BipartiteNodes, forEachLine, type NativeCountEdge, type NativeTypedNode } from "./native";

type CountsParser = Extract<Parser, { format: "user-item-counts" }>;

const FORMAT = "user-item-counts";

/** The text each delimiter option separates a line's fields with. */
const SEPARATORS: Readonly<Record<CountsParser["delimiter"], string>> = { tab: "\t" };

/** The prefix an id takes from the set it is in, so that user 2 and artist 2, which the source numbers independently, are two nodes. */
const USER_PREFIX = "u:";
const ITEM_PREFIXES: Readonly<Record<CountsParser["itemType"], string>> = { artist: "a:" };

/** The node type of a user, and the edge type of each item type's counts: a count of plays for an artist. */
const USER_TYPE = "user";
const EDGE_TYPES: Readonly<Record<CountsParser["itemType"], string>> = { artist: "listened" };

/** A count: digits only, so `Number` cannot read hex, an empty string or infinity. */
const COUNT = /^\d+$/;

/** The fields on a count's line: the user, the item and the count. */
const FIELDS = 3;

/**
 * Parses a file of user-item counts, one per line as `user`, `item` and `count` separated by the recipe's delimiter, after `skipLines` header lines, into a bipartite graph. This is the layout of the HetRec 2011 Last.fm release's `user_artists.dat` (tab, one header line, the count being how many times the user listened to the artist).
 *
 * Nodes are the users and the items in order of first appearance, a user as `u:<id>` of type `user` and an item with its type's prefix (`a:<id>` for an artist) and type. Each line is one edge from its user to its item, in file order, with the item type's edge type (`listened` for an artist) and `weight` the count. Blank lines are skipped.
 * @param pieces - The file's text, in order.
 * @param options - The recipe's parser.
 * @returns The native graph.
 * @throws NativeParseError naming the line for a line without exactly three fields, an empty id or a count that is not a positive whole number, and when the file holds no counts.
 */
export function parseUserItemCounts(pieces: Readonly<Iterable<string>>, options: Readonly<CountsParser>): { readonly nodes: readonly NativeTypedNode[]; readonly edges: readonly NativeCountEdge[] } {
  const separator = SEPARATORS[options.delimiter];
  const graph = new BipartiteNodes();
  const users = graph.set(USER_PREFIX, USER_TYPE);
  const items = graph.set(ITEM_PREFIXES[options.itemType], options.itemType);
  const type = EDGE_TYPES[options.itemType];
  const edges: NativeCountEdge[] = [];
  let lastLine = 0;
  forEachLine(pieces, (line, number) => {
    lastLine = number;
    if (number <= options.skipLines || line.trim() === "") {
      return;
    }
    const fields = line.split(separator);
    const [user, item, count] = fields;
    if (fields.length !== FIELDS || user === undefined || item === undefined || count === undefined) {
      throw new NativeParseError(FORMAT, number, `expected ${String(FIELDS)} fields (user, item, count), found ${String(fields.length)}`);
    }
    if (user === "" || item === "") {
      throw new NativeParseError(FORMAT, number, `the ${user === "" ? USER_TYPE : options.itemType} id is empty`);
    }
    if (!COUNT.test(count) || Number(count) === 0 || !Number.isSafeInteger(Number(count))) {
      throw new NativeParseError(FORMAT, number, `the count ${JSON.stringify(count)} is not a positive whole number`);
    }
    edges.push({ source: users(user), target: items(item), type, weight: Number(count) });
  });
  if (edges.length === 0) {
    throw new NativeParseError(FORMAT, lastLine, "the file holds no counts");
  }

  return { nodes: graph.nodes(), edges };
}
