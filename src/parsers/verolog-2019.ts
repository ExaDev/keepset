import { NativeParseError } from "../errors";
import { lines, type NativeInstance, type NativeRow } from "./native";

/** The columns of a node of a VeRoLog 2019 file, as the parser names them: the position of the node's location, whether it is the depot or a request, the location's id, the first and last day the request may be delivered on, the id of the machine requested (its `machine`, which is the skill a technician needs to install it) and how many are requested. */
export const VEROLOG_2019_COLUMNS = ["x", "y", "kind", "location", "fromDay", "toDay", "machine", "amount"] as const;

/** The columns whose values are text; the others are numbers. */
export const VEROLOG_2019_TEXT_COLUMNS = ["kind", "machine"] as const;

/** The metadata keys the parser reads: the header values, and the number of technicians in the file. */
export const VEROLOG_2019_META = ["dataset", "name", "days", "truckCapacity", "truckMaxDistance", "truckDistanceCost", "truckDayCost", "truckCost", "technicianDistanceCost", "technicianDayCost", "technicianCost", "technicians"] as const;

const FORMAT = "verolog-2019";

/** The header lines, in the order the file has them, with the key of `meta` each fills and whether its value is text. */
const HEADER: readonly (readonly [string, (typeof VEROLOG_2019_META)[number], "text" | "number"])[] = [
  ["DATASET", "dataset", "text"],
  ["NAME", "name", "text"],
  ["DAYS", "days", "number"],
  ["TRUCK_CAPACITY", "truckCapacity", "number"],
  ["TRUCK_MAX_DISTANCE", "truckMaxDistance", "number"],
  ["TRUCK_DISTANCE_COST", "truckDistanceCost", "number"],
  ["TRUCK_DAY_COST", "truckDayCost", "number"],
  ["TRUCK_COST", "truckCost", "number"],
  ["TECHNICIAN_DISTANCE_COST", "technicianDistanceCost", "number"],
  ["TECHNICIAN_DAY_COST", "technicianDayCost", "number"],
  ["TECHNICIAN_COST", "technicianCost", "number"],
];

/** The sections that hold rows, and how many numbers a row has before the per-machine flags of a technician. */
const SECTIONS = ["MACHINES", "LOCATIONS", "REQUESTS", "TECHNICIANS"] as const;
type SectionName = (typeof SECTIONS)[number];

const MACHINE_NUMBERS = 3;
const LOCATION_NUMBERS = 3;
const REQUEST_NUMBERS = 6;
/** Where a request row keeps its fields after the id. */
const REQUEST_AT = { location: 1, fromDay: 2, toDay: 3, machine: 4, amount: 5 } as const;
const TECHNICIAN_NUMBERS_BEFORE_FLAGS = 4;
const WHOLE = /^\d+$/;
const NUMBER = /^-?\d+(?:\.\d+)?$/;

/** A non-empty line split into its fields, with the line it came from. */
interface Row {
  readonly line: number;
  readonly fields: readonly string[];
}

/**
 * Splits the file into non-empty rows of fields. The three layouts the files come in (space padded, tab separated with trailing tabs, and semicolon separated with trailing semicolons) differ only in separator and padding, so any run of whitespace and semicolons separates fields and empty fields are dropped.
 * @param text - The file text.
 * @returns The rows, in file order.
 */
function rowsOf(text: string): Row[] {
  return lines(text)
    .map((raw, index) => ({ line: index + 1, fields: raw.split(/[;\s]+/).filter((field) => field !== "") }))
    .filter((row) => row.fields.length > 0);
}

/**
 * Reads a field as a finite number.
 * @param row - The row.
 * @param index - The field's position in it.
 * @param what - What the field should be, for the error.
 * @returns The number.
 * @throws NativeParseError when the field is absent or not a decimal number.
 */
function numberAt(row: Row, index: number, what: string): number {
  const field = row.fields[index];
  if (field === undefined || !NUMBER.test(field)) {
    throw new NativeParseError(FORMAT, row.line, `expected ${what}, found ${JSON.stringify(field)}`);
  }

  return Number(field);
}

/**
 * Reads a `KEY = value` row: the key, and the fields after the equals sign.
 * @param row - The row.
 * @returns The key and the value fields, or undefined for a row that is not of that form.
 */
function keyed(row: Row): { readonly key: string; readonly value: readonly string[] } | undefined {
  const [key, equals, ...value] = row.fields;

  return key !== undefined && equals === "=" ? { key, value } : undefined;
}

/**
 * Checks that the rows of a section run from 1 with consecutive ids and have the length they should.
 * @param name - The section.
 * @param rows - Its rows.
 * @param length - How many fields a row must have, or undefined when only a minimum applies.
 * @throws NativeParseError naming the line of a row whose id is not the next one or whose length is wrong.
 */
function checkRows(name: SectionName, rows: readonly Row[], length: number | undefined): void {
  for (const [index, row] of rows.entries()) {
    if (row.fields[0] !== String(index + 1)) {
      throw new NativeParseError(FORMAT, row.line, `expected ${name} row ${String(index + 1)} to start with that id, found ${JSON.stringify(row.fields[0])}`);
    }
    if (length !== undefined && row.fields.length !== length) {
      throw new NativeParseError(FORMAT, row.line, `expected ${String(length)} fields in a ${name} row, found ${String(row.fields.length)}`);
    }
  }
}

/** The rows of each section of a file. */
type Sections = Readonly<Record<SectionName, readonly Row[]>>;

/**
 * Splits the rows after the header into the rows of each section, each announced by `NAME = count`.
 * @param rows - The rows after the header.
 * @returns The rows of each section.
 * @throws NativeParseError naming the line for a section that is out of order, announced twice or short of its count, or a row outside any section.
 */
function sectionsOf(rows: readonly Row[]): Sections {
  const found: Partial<Record<SectionName, Row[]>> = {};
  let at = 0;
  for (const name of SECTIONS) {
    const start = rows[at];
    const announced = start === undefined ? undefined : keyed(start);
    if (start === undefined || announced?.key !== name || announced.value.length !== 1 || !WHOLE.test(announced.value[0] ?? "")) {
      throw new NativeParseError(FORMAT, start?.line ?? 1, `expected "${name} = <count>", found ${JSON.stringify(start?.fields.join(" "))}`);
    }
    const count = Number(announced.value[0]);
    const body = rows.slice(at + 1, at + 1 + count);
    if (body.length !== count) {
      throw new NativeParseError(FORMAT, start.line, `${name} announces ${String(count)} rows, found ${String(body.length)}`);
    }
    found[name] = body;
    at += 1 + count;
  }
  const extra = rows[at];
  if (extra !== undefined) {
    throw new NativeParseError(FORMAT, extra.line, `expected the end of the file after TECHNICIANS, found ${JSON.stringify(extra.fields.join(" "))}`);
  }

  return { MACHINES: found.MACHINES ?? [], LOCATIONS: found.LOCATIONS ?? [], REQUESTS: found.REQUESTS ?? [], TECHNICIANS: found.TECHNICIANS ?? [] };
}

/**
 * Parses a VeRoLog Solver Challenge 2019 instance (the technician and truck routing problem of ORTEC's challenge): `KEY = value` header lines, then the sections MACHINES (id, size, idle penalty), LOCATIONS (id, x, y), REQUESTS (id, location, first day, last day, machine, amount) and TECHNICIANS (id, home location, maximum distance per day, maximum installations per day, then a 0 or 1 flag per machine for the machines the technician can install). Location 1 is the depot. The nodes are the depot, then one node per request at its location's position, carrying the request's day window, machine and amount; the machines and technicians stay unread beyond the technician count, as tasks/v1 has no place for a fleet. The days are day numbers, not times, and distances are the integer coordinates' own units.
 * @param text - The file text.
 * @returns The instance: its header values as `meta` and its nodes.
 * @throws NativeParseError naming the line for a header line that is missing, out of order or not of its type, a section that is out of order or short, a row whose ids or length are wrong, or a request whose location, machine or days are outside the file's.
 */
export function parseVerolog2019(text: string): NativeInstance {
  const rows = rowsOf(text);
  const meta: Record<string, string | number> = {};
  let days = 0;
  for (const [position, [key, name, kind]] of HEADER.entries()) {
    const row = rows[position];
    const header = row === undefined ? undefined : keyed(row);
    if (row === undefined || header?.key !== key || header.value.length === 0) {
      throw new NativeParseError(FORMAT, row?.line ?? 1, `expected "${key} = <value>", found ${JSON.stringify(row?.fields.join(" "))}`);
    }
    meta[name] = kind === "text" ? header.value.join(" ") : numberAt({ line: row.line, fields: header.value }, 0, `a number for ${key}`);
    if (key === "DAYS") {
      days = Number(meta[name]);
    }
  }
  const sections = sectionsOf(rows.slice(HEADER.length));
  const machines = sections.MACHINES;
  const locations = sections.LOCATIONS;
  checkRows("MACHINES", machines, MACHINE_NUMBERS);
  checkRows("LOCATIONS", locations, LOCATION_NUMBERS);
  checkRows("REQUESTS", sections.REQUESTS, REQUEST_NUMBERS);
  checkRows("TECHNICIANS", sections.TECHNICIANS, TECHNICIAN_NUMBERS_BEFORE_FLAGS + machines.length);
  const position = (id: number): { readonly x: number; readonly y: number } => {
    const row = locations[id - 1];

    return row === undefined ? { x: Number.NaN, y: Number.NaN } : { x: numberAt(row, 1, "x"), y: numberAt(row, 2, "y") };
  };
  const depot: NativeRow = { id: "depot", ...position(1), kind: "depot", location: 1, fromDay: null, toDay: null, machine: null, amount: null };
  const requests: NativeRow[] = sections.REQUESTS.map((row) => {
    const location = numberAt(row, REQUEST_AT.location, "a location id");
    const fromDay = numberAt(row, REQUEST_AT.fromDay, "the first day");
    const toDay = numberAt(row, REQUEST_AT.toDay, "the last day");
    const machine = numberAt(row, REQUEST_AT.machine, "a machine id");
    const amount = numberAt(row, REQUEST_AT.amount, "the amount");
    if (!Number.isInteger(location) || location < 1 || location > locations.length) {
      throw new NativeParseError(FORMAT, row.line, `location ${String(location)} is outside 1 to ${String(locations.length)}`);
    }
    if (!Number.isInteger(machine) || machine < 1 || machine > machines.length) {
      throw new NativeParseError(FORMAT, row.line, `machine ${String(machine)} is outside 1 to ${String(machines.length)}`);
    }
    if (fromDay < 1 || fromDay > toDay || toDay > days) {
      throw new NativeParseError(FORMAT, row.line, `the days ${String(fromDay)} to ${String(toDay)} are not within 1 to ${String(days)}`);
    }
    if (amount < 1) {
      throw new NativeParseError(FORMAT, row.line, `expected an amount of at least 1, found ${String(amount)}`);
    }

    return { id: row.fields[0] ?? "", ...position(location), kind: "request", location, fromDay, toDay, machine: String(machine), amount };
  });

  return { meta: { ...meta, technicians: sections.TECHNICIANS.length }, nodes: [depot, ...requests] };
}
