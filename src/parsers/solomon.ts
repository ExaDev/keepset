import { NativeParseError } from "../errors";
import { lines, type NativeInstance, type NativeRow } from "./native";

/** The columns of a node of a Solomon style file, as the parser names them: the position (planar for Solomon's own files, latitude then longitude in the Tenerife set), the demand, the time window and the service time. */
export const SOLOMON_COLUMNS = ["x", "y", "demand", "ready", "due", "service"] as const;

/** The metadata keys the parser reads: the instance's name (its first line), the vehicle count and the vehicle capacity. */
export const SOLOMON_META = ["name", "vehicles", "capacity"] as const;

const FORMAT = "solomon";

/** A line of integers or decimals separated by any run of spaces and tabs, as the files write rows (Solomon's with padded spaces, the Tenerife set with tabs). */
const NUMBER = /^-?\d+(?:\.\d+)?$/;

/**
 * Reads a token as a finite number.
 * @param token - The token.
 * @param line - The 1-based line, for the error.
 * @param what - What the token should be, for the error.
 * @returns The number.
 * @throws NativeParseError when the token is not a decimal number.
 */
function numberOf(token: string, line: number, what: string): number {
  if (!NUMBER.test(token)) {
    throw new NativeParseError(FORMAT, line, `expected ${what}, found ${JSON.stringify(token)}`);
  }

  return Number(token);
}

/**
 * Parses a Solomon style vehicle routing instance (R. M. Solomon, 1987): a name on the first line, a `VEHICLE` section holding the number of vehicles and their capacity, and a `CUSTOMER` section of one row per node, the depot first, with its id, position, demand, ready time, due date and service time. Columns are separated by any run of spaces or tabs, so the original files and the tab separated Tenerife set read alike, and blank or whitespace only lines are skipped. The header lines (`NUMBER CAPACITY` and the column titles) are not read: a row is a line of exactly seven numbers after the `CUSTOMER` keyword, and anything else after it is an error. Node ids are kept as the file writes them, so a file whose ids are not consecutive keeps its own. The time quantities are in the unit the source uses, which the format does not record.
 * @param text - The file text.
 * @returns The instance: its name, vehicle count and capacity as `meta`, and its nodes in file order.
 * @throws NativeParseError naming the line for a missing name, `VEHICLE` or `CUSTOMER` section, a vehicle line that is not two numbers, a customer row that is not seven numbers, a repeated node id, or a file with no customer.
 */
export function parseSolomon(text: string): NativeInstance {
  const all = lines(text);
  const present = (index: number): string => (all[index] ?? "").trim();
  const name = present(0);
  if (name === "") {
    throw new NativeParseError(FORMAT, 1, "expected the instance name on the first line");
  }
  const meta: { name: string; vehicles?: number; capacity?: number } = { name };
  const nodes: NativeRow[] = [];
  const seen = new Set<string>();
  let section: "preamble" | "vehicle" | "customer" = "preamble";
  let awaitingHeader = false;
  for (const [index, raw] of all.entries()) {
    const line = index + 1;
    const trimmed = raw.trim();
    if (index === 0 || trimmed === "") {
      continue;
    }
    const keyword = trimmed.toUpperCase();
    if (keyword === "VEHICLE" || keyword === "CUSTOMER") {
      section = keyword === "VEHICLE" ? "vehicle" : "customer";
      awaitingHeader = true;
      continue;
    }
    if (section === "preamble") {
      throw new NativeParseError(FORMAT, line, `expected VEHICLE or CUSTOMER, found ${JSON.stringify(trimmed)}`);
    }
    if (awaitingHeader) {
      // The line after a section keyword holds the column titles, which carry no data.
      awaitingHeader = false;
      continue;
    }
    const tokens = trimmed.split(/\s+/);
    if (section === "vehicle") {
      const [vehicles, capacity, ...extra] = tokens;
      if (vehicles === undefined || capacity === undefined || extra.length > 0) {
        throw new NativeParseError(FORMAT, line, `expected the vehicle count and capacity, found ${JSON.stringify(trimmed)}`);
      }
      meta.vehicles = numberOf(vehicles, line, "the vehicle count");
      meta.capacity = numberOf(capacity, line, "the vehicle capacity");
      continue;
    }
    const [id, x, y, demand, ready, due, service, ...extra] = tokens;
    if (id === undefined || x === undefined || y === undefined || demand === undefined || ready === undefined || due === undefined || service === undefined || extra.length > 0) {
      throw new NativeParseError(FORMAT, line, `expected seven numbers (id, x, y, demand, ready, due, service), found ${JSON.stringify(trimmed)}`);
    }
    if (!/^\d+$/.test(id)) {
      throw new NativeParseError(FORMAT, line, `expected a whole number node id, found ${JSON.stringify(id)}`);
    }
    if (seen.has(id)) {
      throw new NativeParseError(FORMAT, line, `node ${id} appears twice`);
    }
    seen.add(id);
    nodes.push({
      id,
      x: numberOf(x, line, "x"),
      y: numberOf(y, line, "y"),
      demand: numberOf(demand, line, "the demand"),
      ready: numberOf(ready, line, "the ready time"),
      due: numberOf(due, line, "the due date"),
      service: numberOf(service, line, "the service time"),
    });
  }
  if (section !== "customer") {
    throw new NativeParseError(FORMAT, all.length, "expected a CUSTOMER section");
  }
  if (nodes.length === 0) {
    throw new NativeParseError(FORMAT, all.length, "the CUSTOMER section has no rows");
  }
  if (meta.vehicles === undefined || meta.capacity === undefined) {
    throw new NativeParseError(FORMAT, all.length, "expected a VEHICLE section with the vehicle count and capacity");
  }

  return { meta: { name: meta.name, vehicles: meta.vehicles, capacity: meta.capacity }, nodes };
}
