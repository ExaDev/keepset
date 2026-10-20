import { NativeParseError } from "../errors";
import { lines, type NativeInstance, type NativeRow } from "./native";

/** The columns of a node of a customer points file, as the parser names them: the planar position. */
export const CUSTOMER_POINTS_COLUMNS = ["x", "y"] as const;

/** The columns whose values are text; the others are numbers. Both columns of a customer points file are numbers. */
export const CUSTOMER_POINTS_TEXT_COLUMNS = [] as const;

/** The metadata keys the parser reads: the number of customers the file announces. */
export const CUSTOMER_POINTS_META = ["customers"] as const;

const FORMAT = "customer-points";

const NUMBER = /^-?\d+(?:\.\d+)?$/;
const WHOLE = /^\d+$/;

/**
 * Parses a customer points file, as the OAR Bench arc routing benchmark generator writes the customers of an instance: the line `customers <count>`, then one row per customer of its id, x and y, separated by tabs or spaces, with blank lines skipped. The positions are planar coordinates in the instance's own unit, which the file does not name. The row count must be the announced count, which catches a truncated file.
 * @param text - The file text.
 * @returns The instance: the customer count as `meta` and the customers as nodes, in file order.
 * @throws NativeParseError naming the line for a first line that is not `customers <count>`, a row that is not an id and two numbers, a repeated id, or a row count that is not the announced one.
 */
export function parseCustomerPoints(text: string): NativeInstance {
  const rows = lines(text)
    .map((raw, index) => ({ line: index + 1, fields: raw.trim().split(/\s+/).filter((field) => field !== "") }))
    .filter((row) => row.fields.length > 0);
  const [first, ...body] = rows;
  const [key, count, ...extra] = first?.fields ?? [];
  if (first === undefined || key !== "customers" || count === undefined || !WHOLE.test(count) || extra.length > 0) {
    throw new NativeParseError(FORMAT, first?.line ?? 1, `expected "customers <count>", found ${JSON.stringify(first?.fields.join(" "))}`);
  }
  const seen = new Set<string>();
  const nodes: NativeRow[] = body.map((row) => {
    const [id, x, y, ...rest] = row.fields;
    if (id === undefined || x === undefined || y === undefined || rest.length > 0 || !WHOLE.test(id) || !NUMBER.test(x) || !NUMBER.test(y)) {
      throw new NativeParseError(FORMAT, row.line, `expected a customer id and two numbers, found ${JSON.stringify(row.fields.join(" "))}`);
    }
    if (seen.has(id)) {
      throw new NativeParseError(FORMAT, row.line, `customer ${id} appears twice`);
    }
    seen.add(id);

    return { id, x: Number(x), y: Number(y) };
  });
  if (nodes.length !== Number(count)) {
    throw new NativeParseError(FORMAT, rows[rows.length - 1]?.line ?? first.line, `the file announces ${count} customers, found ${String(nodes.length)}`);
  }

  return { meta: { customers: Number(count) }, nodes };
}
