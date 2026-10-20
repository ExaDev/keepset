import { NativeParseError } from "../errors";
import { lines, type NativeInstance, type NativeRow } from "./native";

/** The columns of a node of a team orienteering file, as the parser names them: the position, the score, and whether it is where the paths start, where they end or a point to visit. */
export const TOP_COLUMNS = ["x", "y", "score", "role"] as const;

/** The metadata keys the parser reads: the number of points, the number of paths and the length budget of each path. */
export const TOP_META = ["points", "paths", "budget"] as const;

const FORMAT = "top";

/** The header lines before the first point: `n`, `m` and `tmax`. */
const HEADER_LINES = 3;

const NUMBER = /^-?\d+(?:\.\d+)?$/;

/**
 * Reads the value of a header line `<key> <number>`.
 * @param text - The line.
 * @param key - The key it must start with.
 * @param line - The 1-based line, for the error.
 * @returns The number.
 * @throws NativeParseError when the line is not the key and one number.
 */
function headerOf(text: string | undefined, key: string, line: number): number {
  const tokens = (text ?? "").trim().split(/\s+/);
  const [name, value, ...extra] = tokens;
  if (name !== key || value === undefined || extra.length > 0 || !NUMBER.test(value)) {
    throw new NativeParseError(FORMAT, line, `expected "${key} <number>", found ${JSON.stringify((text ?? "").trim())}`);
  }

  return Number(value);
}

/**
 * Parses a team orienteering problem instance (Chao, Golden and Wasil, as the KU Leuven pages describe it): `n <points>`, `m <paths>` and `tmax <budget>` on three lines, then one row of position and score for each point. The first point is where the paths start and the last is where they end, and the rest are to visit; the file has no ids, so a point's id is its zero-based row number. Columns are separated by any run of spaces or tabs, and blank or whitespace only lines are skipped. The positions and the budget are in the same planar unit, which the format does not name.
 * @param text - The file text.
 * @returns The instance: its point count, path count and per-path budget as `meta`, and its nodes in file order.
 * @throws NativeParseError naming the line for a missing or misordered header line, a row that is not three numbers, or a row count that is not the point count.
 */
export function parseTop(text: string): NativeInstance {
  const all = lines(text)
    .map((raw, index) => ({ line: index + 1, text: raw.trim() }))
    .filter((entry) => entry.text !== "");
  const [first, second, third] = all;
  const rows = all.slice(HEADER_LINES);
  const points = headerOf(first?.text, "n", first?.line ?? 1);
  const paths = headerOf(second?.text, "m", second?.line ?? 2);
  const budget = headerOf(third?.text, "tmax", third?.line ?? HEADER_LINES);
  if (!Number.isInteger(points) || points < 2) {
    throw new NativeParseError(FORMAT, first?.line ?? 1, `expected at least a start and an end point, found n ${String(points)}`);
  }
  if (rows.length !== points) {
    throw new NativeParseError(FORMAT, all[all.length - 1]?.line ?? 1, `the header gives ${String(points)} points, found ${String(rows.length)} rows`);
  }
  const nodes: NativeRow[] = rows.map((row, index) => {
    const tokens = row.text.split(/\s+/);
    const [x, y, score, ...extra] = tokens;
    if (x === undefined || y === undefined || score === undefined || extra.length > 0 || !NUMBER.test(x) || !NUMBER.test(y) || !NUMBER.test(score)) {
      throw new NativeParseError(FORMAT, row.line, `expected three numbers (x, y, score), found ${JSON.stringify(row.text)}`);
    }

    return { id: String(index), x: Number(x), y: Number(y), score: Number(score), role: index === 0 ? "start" : index === points - 1 ? "end" : "visit" };
  });

  return { meta: { points, paths, budget }, nodes };
}
