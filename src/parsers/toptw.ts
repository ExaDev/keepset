import { NativeParseError } from "../errors";
import { lines, type NativeInstance, type NativeRow } from "./native";

/** The columns of a node of a TOPTW file, as the parser names them: the position, the service duration, the profit, and the opening and closing of the time window. */
export const TOPTW_COLUMNS = ["x", "y", "service", "profit", "open", "close"] as const;

/** The columns whose values are text; the others are numbers. Every column of a TOPTW file is a number. */
export const TOPTW_TEXT_COLUMNS = [] as const;

/** The metadata keys the parser reads: the number of paths the tour is split into, the number of customers and the vehicle capacity. */
export const TOPTW_META = ["paths", "customers", "capacity"] as const;

const FORMAT = "toptw";

/** How many numbers the first header line holds (k, paths, customers, t) and the second (D, capacity). */
const FIRST_HEADER_NUMBERS = 4;
const SECOND_HEADER_NUMBERS = 2;

/** Where a node row's fields sit: the length of the unused list is the seventh token, the list follows, and the window's opening and closing come after it. A row without a list is the first token to the window's closing, so it holds this many numbers plus the list's length. */
const LIST_LENGTH_AT = 6;
const LIST_STARTS_AT = 7;
const ROW_NUMBERS_BESIDE_LIST = 9;

const NUMBER = /^-?\d+(?:\.\d+)?$/;

/**
 * Reads a token as a finite number.
 * @param token - The token.
 * @param line - The 1-based line, for the error.
 * @param what - What the token should be, for the error.
 * @returns The number.
 * @throws NativeParseError when the token is not a decimal number.
 */
function numberOf(token: string | undefined, line: number, what: string): number {
  if (token === undefined || !NUMBER.test(token)) {
    throw new NativeParseError(FORMAT, line, `expected ${what}, found ${JSON.stringify(token)}`);
  }

  return Number(token);
}

/**
 * Reads a line of a given number of numbers.
 * @param text - The line.
 * @param count - How many numbers it holds.
 * @param line - The 1-based line, for the error.
 * @param what - What the line should be, for the error.
 * @returns The numbers.
 * @throws NativeParseError when the line does not hold exactly that many numbers.
 */
function numbersOf(text: string, count: number, line: number, what: string): number[] {
  const tokens = text.trim().split(/\s+/);
  if (tokens.length !== count) {
    throw new NativeParseError(FORMAT, line, `expected ${what}, found ${JSON.stringify(text.trim())}`);
  }

  return tokens.map((token) => numberOf(token, line, what));
}

/**
 * Parses a team orienteering problem with time windows instance (TOPTW, in the layout of Righini and Salani, as the KU Leuven pages describe it). The first line holds four numbers, of which the second is the number of paths and the third the number of customers, the second line two, of which the second is the vehicle capacity, and then one row per node, the depot first: its id, position, service duration, profit, an unused number, the length of a list of unused numbers, that list, and the opening and closing of its time window. Columns are separated by any run of spaces, and blank or whitespace only lines are skipped. The row count must be the customer count plus one, which catches a truncated file. The time quantities are in the unit of the source's coordinate grid, which the format does not name.
 * @param text - The file text.
 * @returns The instance: its path count, customer count and capacity as `meta`, and its nodes in file order.
 * @throws NativeParseError naming the line for a header or row that is not made of the numbers the format has, a row whose length does not match its list, a repeated node id, or a row count that is not the customer count plus one.
 */
export function parseToptw(text: string): NativeInstance {
  const all = lines(text)
    .map((raw, index) => ({ line: index + 1, text: raw.trim() }))
    .filter((entry) => entry.text !== "");
  const [first, second, ...rows] = all;
  if (first === undefined || second === undefined) {
    throw new NativeParseError(FORMAT, 1, "expected the two header lines");
  }
  const [, paths, customers] = numbersOf(first.text, FIRST_HEADER_NUMBERS, first.line, "four numbers (k, paths, customers, t)");
  const [, capacity] = numbersOf(second.text, SECOND_HEADER_NUMBERS, second.line, "two numbers (D, capacity)");
  if (paths === undefined || customers === undefined || capacity === undefined) {
    throw new NativeParseError(FORMAT, first.line, "the header lacks a number");
  }
  const seen = new Set<string>();
  const nodes: NativeRow[] = rows.map((row) => {
    const tokens = row.text.split(/\s+/);
    const listLength = numberOf(tokens[LIST_LENGTH_AT], row.line, "the length of the list after the unused number");
    if (!Number.isInteger(listLength) || listLength < 0 || tokens.length !== ROW_NUMBERS_BESIDE_LIST + listLength) {
      throw new NativeParseError(FORMAT, row.line, `expected ${String(ROW_NUMBERS_BESIDE_LIST + listLength)} numbers for a list of ${String(listLength)}, found ${String(tokens.length)}`);
    }
    const [id] = tokens;
    if (id === undefined || !/^\d+$/.test(id)) {
      throw new NativeParseError(FORMAT, row.line, `expected a whole number node id, found ${JSON.stringify(id)}`);
    }
    if (seen.has(id)) {
      throw new NativeParseError(FORMAT, row.line, `node ${id} appears twice`);
    }
    seen.add(id);

    return {
      id,
      x: numberOf(tokens[1], row.line, "x"),
      y: numberOf(tokens[2], row.line, "y"),
      service: numberOf(tokens[3], row.line, "the service duration"),
      profit: numberOf(tokens[4], row.line, "the profit"),
      open: numberOf(tokens[LIST_STARTS_AT + listLength], row.line, "the opening of the window"),
      close: numberOf(tokens[LIST_STARTS_AT + 1 + listLength], row.line, "the closing of the window"),
    };
  });
  if (nodes.length !== customers + 1) {
    throw new NativeParseError(FORMAT, all.length === 0 ? 1 : (all[all.length - 1]?.line ?? 1), `the header gives ${String(customers)} customers, so expected ${String(customers + 1)} rows with the depot, found ${String(nodes.length)}`);
  }

  return { meta: { paths, customers, capacity }, nodes };
}
