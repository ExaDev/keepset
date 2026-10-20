import type { Parser } from "../entry";
import { SOLOMON_COLUMNS, SOLOMON_META } from "./solomon";
import { TOP_COLUMNS, TOP_META } from "./top";
import { TOPTW_COLUMNS, TOPTW_META } from "./toptw";

/** What each instance file parser emits, by its format name: the columns of a node (besides its `id`) and the keys of the instance's own `meta`. A recipe's crosswalk maps these, and the seed import checks a curation against them. */
export const INSTANCE_SHAPES = {
  solomon: { columns: SOLOMON_COLUMNS, meta: SOLOMON_META },
  top: { columns: TOP_COLUMNS, meta: TOP_META },
  toptw: { columns: TOPTW_COLUMNS, meta: TOPTW_META },
} as const;

/** The format names of the instance file parsers. */
export type InstanceFormat = keyof typeof INSTANCE_SHAPES;

/** A parser of an instance file format. */
export type InstanceParser = Extract<Parser, { readonly format: InstanceFormat }>;

/**
 * Whether a parser reads an instance file format, whose output is a node list with a header `meta` of its own.
 * @param parser - Any parser.
 * @returns True for an instance file parser.
 */
export function isInstanceParser(parser: Parser): parser is InstanceParser {
  return Object.hasOwn(INSTANCE_SHAPES, parser.format);
}
