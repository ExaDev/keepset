import { NativeParseError } from "../errors";
import { lines, type NativeInstance, type NativeRow } from "./native";

/** The columns of a node of a VeRoLog 2017 file, as the parser names them: its position, whether it is the depot or a request, the location's id, the first and last day the tools may be delivered, how many days they stay, the kind of tool and how many are requested. */
export const VEROLOG_2017_COLUMNS = ["x", "y", "kind", "location", "fromDay", "toDay", "stayDays", "tool", "amount"] as const;

/** The columns whose values are text; the others are numbers. */
export const VEROLOG_2017_TEXT_COLUMNS = ["kind", "tool"] as const;

/** The metadata keys the parser reads: the header values, and the number of tool kinds in the file. */
export const VEROLOG_2017_META = ["dataset", "name", "days", "capacity", "maxTripDistance", "depotCoordinate", "vehicleCost", "vehicleDayCost", "distanceCost", "tools"] as const;

const FORMAT = "verolog-2017";

/** The header lines, with the key of `meta` each fills and whether its value is text. */
const HEADER: ReadonlyMap<string, readonly [(typeof VEROLOG_2017_META)[number], "text" | "number"]> = new Map([
  ["DATASET", ["dataset", "text"]],
  ["NAME", ["name", "text"]],
  ["DAYS", ["days", "number"]],
  ["CAPACITY", ["capacity", "number"]],
  ["MAX_TRIP_DISTANCE", ["maxTripDistance", "number"]],
  ["DEPOT_COORDINATE", ["depotCoordinate", "number"]],
  ["VEHICLE_COST", ["vehicleCost", "number"]],
  ["VEHICLE_DAY_COST", ["vehicleDayCost", "number"]],
  ["DISTANCE_COST", ["distanceCost", "number"]],
]);

/** The sections that hold rows, and how many numbers each row has. */
const SECTION_WIDTHS = { TOOLS: 4, COORDINATES: 3, REQUESTS: 7 } as const;
type SectionName = keyof typeof SECTION_WIDTHS;

/** Where a request row keeps its fields. */
const REQUEST_AT = { id: 0, location: 1, fromDay: 2, toDay: 3, stayDays: 4, tool: 5, amount: 6 } as const;
const WHOLE = /^-?\d+$/;

/** A row of numbers and the line it came from. */
interface Row {
  readonly line: number;
  readonly values: readonly number[];
}

/**
 * Reads a field of a row.
 * @param row - The row.
 * @param index - The field's position.
 * @returns The number.
 * @throws NativeParseError when the row has no such field.
 */
function at(row: Row, index: number): number {
  const value = row.values[index];
  if (value === undefined) {
    throw new NativeParseError(FORMAT, row.line, `the row has no field ${String(index + 1)}`);
  }

  return value;
}

/**
 * Parses an instance of the ORTEC VeRoLog Solver Challenge 2016 to 2017 (Kheiri et al. 2019): `KEY = value` header lines (the dataset and instance names, the planning days, the vehicle capacity, the longest trip, the depot's coordinate id and the three costs), then three sections each opened by `NAME = <count>` and followed by that many rows of whole numbers: `TOOLS` (id, size, how many are available, cost a day), `COORDINATES` (id, x, y) and `REQUESTS` (id, location, first day, last day, days the tools stay, tool kind, how many). Fields are separated by runs of spaces or tabs, and blank lines are skipped. The nodes are the depot, at its coordinate, with the id `depot`, then one node per request under the request's id at the position of its location. The tool table's sizes, availability and costs are not node fields and are not kept; its row count is.
 * @param text - The file text.
 * @returns The instance: its header values and tool count as `meta`, and its nodes, the depot first and the requests in file order.
 * @throws NativeParseError naming the line for an unknown or repeated key, a header value that is not a number where one is due, a missing header line or section, a section with a different number of rows than it says, a row that is not its section's count of whole numbers, a coordinate given twice, a request at a location the file does not give, or a request id given twice.
 */
export function parseVerolog2017(text: string): NativeInstance {
  const meta = new Map<string, string | number>();
  const sections = new Map<SectionName, Row[]>();
  let open: { readonly name: SectionName; readonly rows: Row[]; readonly count: number; readonly line: number } | undefined;
  const close = (): void => {
    if (open !== undefined && open.rows.length !== open.count) {
      throw new NativeParseError(FORMAT, open.line, `the ${open.name} section says ${String(open.count)} rows and has ${String(open.rows.length)}`);
    }
    open = undefined;
  };
  for (const [index, raw] of lines(text).entries()) {
    const line = index + 1;
    const trimmed = raw.trim();
    if (trimmed === "") {
      continue;
    }
    const keyed = /^([A-Z_]+)\s*=\s*(.*)$/.exec(trimmed);
    if (keyed?.[1] !== undefined && keyed[2] !== undefined) {
      close();
      const [, key, value] = keyed;
      const section = Object.keys(SECTION_WIDTHS).find((name): name is SectionName => name === key);
      if (section !== undefined) {
        if (sections.has(section) || !WHOLE.test(value)) {
          throw new NativeParseError(FORMAT, line, sections.has(section) ? `the ${section} section is given twice` : `the ${section} section's count ${JSON.stringify(value)} is not a whole number`);
        }
        const rows: Row[] = [];
        sections.set(section, rows);
        open = { name: section, rows, count: Number(value), line };
        continue;
      }
      const header = HEADER.get(key);
      if (header === undefined || meta.has(header[0])) {
        throw new NativeParseError(FORMAT, line, header === undefined ? `the key ${key} is not one this format has` : `the key ${key} is given twice`);
      }
      const [name, kind] = header;
      if (kind === "number" && !/^-?\d+(?:\.\d+)?$/.test(value)) {
        throw new NativeParseError(FORMAT, line, `${key} must be a number, found ${JSON.stringify(value)}`);
      }
      meta.set(name, kind === "number" ? Number(value) : value);
      continue;
    }
    const tokens = trimmed.split(/\s+/);
    if (open === undefined || tokens.length !== SECTION_WIDTHS[open.name] || !tokens.every((token) => WHOLE.test(token))) {
      throw new NativeParseError(FORMAT, line, open === undefined ? `the row ${JSON.stringify(trimmed)} is outside any section` : `a ${open.name} row is ${String(SECTION_WIDTHS[open.name])} whole numbers, found ${JSON.stringify(trimmed)}`);
    }
    open.rows.push({ line, values: tokens.map(Number) });
  }
  close();
  for (const [key, [name]] of HEADER) {
    if (!meta.has(name)) {
      throw new NativeParseError(FORMAT, 1, `the file has no ${key} line`);
    }
  }
  const rowsOf = (name: SectionName): readonly Row[] => {
    const rows = sections.get(name);
    if (rows === undefined) {
      throw new NativeParseError(FORMAT, 1, `the file has no ${name} section`);
    }

    return rows;
  };
  const tools = rowsOf("TOOLS").length;
  const positions = new Map<number, readonly [number, number]>();
  for (const row of rowsOf("COORDINATES")) {
    const id = at(row, 0);
    if (positions.has(id)) {
      throw new NativeParseError(FORMAT, row.line, `the coordinate ${String(id)} is given twice`);
    }
    positions.set(id, [at(row, 1), at(row, 2)]);
  }
  const positionOf = (location: number, line: number): readonly [number, number] => {
    const position = positions.get(location);
    if (position === undefined) {
      throw new NativeParseError(FORMAT, line, `the location ${String(location)} is not among the coordinates`);
    }

    return position;
  };
  const depot = Number(meta.get("depotCoordinate"));
  const [depotX, depotY] = positionOf(depot, 1);
  const nodes: NativeRow[] = [{ id: "depot", x: depotX, y: depotY, kind: "depot", location: depot, fromDay: null, toDay: null, stayDays: null, tool: null, amount: null }];
  const ids = new Set<string>();
  for (const row of rowsOf("REQUESTS")) {
    const id = String(at(row, REQUEST_AT.id));
    if (ids.has(id)) {
      throw new NativeParseError(FORMAT, row.line, `the request ${id} is given twice`);
    }
    ids.add(id);
    const location = at(row, REQUEST_AT.location);
    const [x, y] = positionOf(location, row.line);
    nodes.push({ id, x, y, kind: "request", location, fromDay: at(row, REQUEST_AT.fromDay), toDay: at(row, REQUEST_AT.toDay), stayDays: at(row, REQUEST_AT.stayDays), tool: String(at(row, REQUEST_AT.tool)), amount: at(row, REQUEST_AT.amount) });
  }

  return { meta: { ...Object.fromEntries(meta), tools }, nodes };
}
