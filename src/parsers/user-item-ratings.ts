import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import { forEachLine, type NativeGraph, type NativeRating, type NativeTypedNode } from "./native";

type RatingsParser = Extract<Parser, { format: "user-item-ratings" }>;

const FORMAT = "user-item-ratings";

/** The text each delimiter option separates a line's fields with. */
const SEPARATORS: Readonly<Record<RatingsParser["delimiter"], string>> = { comma: ",", tab: "\t", "double-colon": "::" };

/** The prefix an id takes from the set it is in, so that user 1 and movie 1, which a source numbers independently, are two nodes: `u:` for a user and the first letter of the item type and a colon for an item. */
const USER_PREFIX = "u:";
const ITEM_PREFIXES: Readonly<Record<RatingsParser["itemType"], string>> = { movie: "m:", product: "p:" };

/** The node type of a user, and the edge type of a rating. */
const USER_TYPE = "user";
const RATING_TYPE = "rating";

/** A rating as a decimal literal: digits with an optional fraction, no sign, so `Number` cannot read it as hex, as an empty string or as infinity. */
const RATING = /^\d+(?:\.\d+)?$/;

/** A time as a count of whole units since the epoch, in digits only. */
const TIMESTAMP = /^\d+$/;

/** The fields on a rating's line: the user, the item, the rating and when it was given. */
const FIELDS = 4;

/**
 * Parses a file of ratings, one per line as `user`, `item`, `rating` and `timestamp` separated by the recipe's delimiter, after `skipLines` header lines, into a bipartite graph. This is the layout of an Amazon ratings-only file (comma, no header) and of each MovieLens release (tab for `u.data`, `::` for `ratings.dat`, comma with a header line for `ratings.csv`).
 *
 * Nodes are the users and the items in order of first appearance, a user as `u:<id>` of type `user` and an item as `m:<id>` or `p:<id>` of the recipe's item type. Each line is one edge from its user to its item, in file order, of type `rating`, with `weight` the rating over the recipe's `maxRating` (so a weight is in (0, 1]) and `timestamp` the time field as the file writes it. Blank lines are skipped. A user who rates an item twice gives two edges.
 *
 * The file is read a piece of text at a time and each distinct id is held once, however many edges name it.
 * @param pieces - The file's text, in order.
 * @param options - The recipe's parser.
 * @returns The native graph.
 * @throws NativeParseError naming the line for a line without exactly four fields, an empty id, a rating that is not a positive number or exceeds `maxRating`, or a timestamp that is not a whole number, and when the file holds no ratings.
 */
export function parseUserItemRatings(pieces: Readonly<Iterable<string>>, options: Readonly<RatingsParser>): NativeGraph {
  const separator = SEPARATORS[options.delimiter];
  const itemPrefix = ITEM_PREFIXES[options.itemType];
  const users = new Map<string, string>();
  const items = new Map<string, string>();
  const nodes: NativeTypedNode[] = [];
  const edges: NativeRating[] = [];
  /** The ids of one node set seen so far, by source id, so each distinct id is held once however many edges name it. */
  const sets = { user: { known: users, prefix: USER_PREFIX, type: USER_TYPE }, item: { known: items, prefix: itemPrefix, type: options.itemType } };
  /** Returns the node id of a source id in a set, adding the node when the id has not appeared in it. */
  const idOf = (set: (typeof sets)[keyof typeof sets], raw: string, number: number): string => {
    if (raw === "") {
      throw new NativeParseError(FORMAT, number, `the ${set.type} id is empty`);
    }
    let id = set.known.get(raw);
    if (id === undefined) {
      id = `${set.prefix}${raw}`;
      set.known.set(raw, id);
      nodes.push({ id, type: set.type });
    }

    return id;
  };
  let lastLine = 0;
  forEachLine(pieces, (line, number) => {
    lastLine = number;
    if (number <= options.skipLines || line.trim() === "") {
      return;
    }
    const fields = line.split(separator);
    const [user, item, rating, timestamp] = fields;
    if (fields.length !== FIELDS || user === undefined || item === undefined || rating === undefined || timestamp === undefined) {
      throw new NativeParseError(FORMAT, number, `expected ${String(FIELDS)} fields (user, item, rating, timestamp), found ${String(fields.length)}`);
    }
    if (!RATING.test(rating) || Number(rating) <= 0 || Number(rating) > options.maxRating) {
      throw new NativeParseError(FORMAT, number, `the rating ${JSON.stringify(rating)} is not a number above 0 and at most ${String(options.maxRating)}`);
    }
    if (!TIMESTAMP.test(timestamp) || !Number.isSafeInteger(Number(timestamp))) {
      throw new NativeParseError(FORMAT, number, `the timestamp ${JSON.stringify(timestamp)} is not a whole number`);
    }
    edges.push({
      source: idOf(sets.user, user, number),
      target: idOf(sets.item, item, number),
      type: RATING_TYPE,
      weight: Number(rating) / options.maxRating,
      timestamp: Number(timestamp),
    });
  });
  if (edges.length === 0) {
    throw new NativeParseError(FORMAT, lastLine, "the file holds no ratings");
  }

  return { nodes, edges };
}
