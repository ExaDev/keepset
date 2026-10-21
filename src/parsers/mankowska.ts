import { NativeParseError } from "../errors";
import { lines, type NativeInstance, type NativeRow } from "./native";

/** The columns of a node of a Mankowska home health care file, as the parser names them: whether it is a depot copy or a patient, its position, the services it requires, the processing time of its first and second required service, its time window, and for a double service the least and most time between its two services. */
export const MANKOWSKA_COLUMNS = ["role", "x", "y", "services", "duration1", "duration2", "earliest", "latest", "minGap", "maxGap"] as const;

/** The columns whose values are text; the others are numbers. */
export const MANKOWSKA_TEXT_COLUMNS = ["role", "services"] as const;

/** The metadata keys the parser reads: how many patients, caregivers (the file's vehicles) and kinds of service the instance has. */
export const MANKOWSKA_META = ["patients", "caregivers", "serviceKinds"] as const;

const FORMAT = "mankowska";

/** The sections of the file, each a keyword on a line of its own followed by its numbers. */
const SECTIONS = ["nbNodes", "nbVehi", "nbServi", "r", "DS", "a", "x", "y", "d", "p", "mind", "maxd", "e", "l"] as const;
type SectionName = (typeof SECTIONS)[number];

/** How many patients a double service has, and so the most required services a patient can have. */
const MOST_SERVICES = 2;
/** The depot copies: the first and the last node. */
const DEPOTS = 2;
const NUMBER = /^-?\d+(?:\.\d+)?$/;
const KEYWORD = /^[A-Za-z]+$/;

/** A section's numbers and the line its keyword is on. */
interface Section {
  readonly line: number;
  readonly values: readonly number[];
}

/**
 * Splits the file into its sections: a line holding one word starts a section, and every number on the lines after it, up to the next such line, is the section's.
 * @param text - The file text.
 * @returns Each section by its keyword.
 * @throws NativeParseError for a keyword the format does not have, one given twice, a value that is not a number, or a number before the first keyword.
 */
function sectionsOf(text: string): ReadonlyMap<SectionName, Section> {
  const sections = new Map<SectionName, { readonly line: number; readonly values: number[] }>();
  let current: number[] | undefined;
  for (const [index, raw] of lines(text).entries()) {
    const tokens = raw.trim().split(/\s+/).filter((token) => token !== "");
    const [only] = tokens;
    if (tokens.length === 1 && only !== undefined && KEYWORD.test(only)) {
      const name = SECTIONS.find((section) => section === only);
      if (name === undefined || sections.has(name)) {
        throw new NativeParseError(FORMAT, index + 1, name === undefined ? `the section ${JSON.stringify(only)} is not one of ${SECTIONS.join(", ")}` : `the section ${name} is given twice`);
      }
      current = [];
      sections.set(name, { line: index + 1, values: current });
      continue;
    }
    for (const token of tokens) {
      if (current === undefined || !NUMBER.test(token)) {
        throw new NativeParseError(FORMAT, index + 1, current === undefined ? "a number comes before the first section" : `expected a number, found ${JSON.stringify(token)}`);
      }
      current.push(Number(token));
    }
  }

  return sections;
}

/**
 * Reads a section that must hold a given count of numbers.
 * @param sections - The sections.
 * @param name - The section.
 * @param count - How many numbers it must hold.
 * @returns Its numbers.
 * @throws NativeParseError when the section is missing or holds another count.
 */
function sized(sections: ReadonlyMap<SectionName, Section>, name: SectionName, count: number): readonly number[] {
  const section = sections.get(name);
  if (section === undefined) {
    throw new NativeParseError(FORMAT, 1, `the file has no ${name} section`);
  }
  if (section.values.length !== count) {
    throw new NativeParseError(FORMAT, section.line, `the ${name} section holds ${String(section.values.length)} numbers where ${String(count)} are due`);
  }

  return section.values;
}

/**
 * Reads a count section (`nbNodes`, `nbVehi`, `nbServi`): one whole number of at least a least value.
 * @param sections - The sections.
 * @param name - The section.
 * @param least - The smallest count that makes an instance.
 * @returns The count.
 * @throws NativeParseError when the section is missing, holds more than one number, or the count is not a whole number of at least `least`.
 */
function countOf(sections: ReadonlyMap<SectionName, Section>, name: SectionName, least: number): number {
  const [count] = sized(sections, name, 1);
  if (count === undefined || !Number.isInteger(count) || count < least) {
    throw new NativeParseError(FORMAT, sections.get(name)?.line ?? 1, `${name} must be a whole number of at least ${String(least)}, found ${String(count)}`);
  }

  return count;
}

/**
 * Reads one cell of a row-major matrix section.
 * @param values - The section's numbers.
 * @param columns - The matrix's width.
 * @param row - The row.
 * @param column - The column.
 * @returns The cell.
 * @throws NativeParseError when the cell is outside the section, which `sized` has already ruled out.
 */
function cell(values: readonly number[], columns: number, row: number, column: number): number {
  const value = values[row * columns + column];
  if (value === undefined) {
    throw new NativeParseError(FORMAT, 1, `cell ${String(row)}, ${String(column)} is outside its section`);
  }

  return value;
}

/**
 * Parses a home health care routing and scheduling instance in the keyword text format of Mankowska, Meisel and Bierwirth (2014), as the OVIG generator writes it: the counts of nodes (`nbNodes`, the patients and two copies of the depot, the first and the last), vehicles (`nbVehi`, the caregivers) and services (`nbServi`); the services each node requires (`r`, a node by service matrix of zeros and ones), the double service nodes (`DS`, node numbers from one), the services each caregiver can give (`a`), the positions (`x`, `y`), the travel matrix (`d`), the processing time of each service at each node by each caregiver (`p`, a row per node and caregiver), the least and most time between a double service's two services (`mind`, `maxd`), and the time windows (`e`, `l`). A node's id is its number from zero. The depot copies are marked as requiring every service, which is the format's convention and not a visit, so they carry no services or processing times. A patient's required services are their numbers from one, joined by spaces, and its first and second processing time are those of its required services in that order. The travel matrix and the caregivers' qualifications are not node fields and are not kept; the processing times must not differ between caregivers, since a node column holds one value. The gaps are kept for a double service node only. The units of time are the generator's own.
 * @param text - The file text.
 * @returns The instance: its patient, caregiver and service kind counts as `meta`, and its nodes in node order.
 * @throws NativeParseError naming the line for a section that is missing, given twice or of the wrong size, a value that is not a number, a requirement that is not zero or one, a node with more than two required services, a double service node with fewer than two or out of range, or processing times that differ between caregivers.
 */
export function parseMankowska(text: string): NativeInstance {
  const sections = sectionsOf(text);
  const nodeCount = countOf(sections, "nbNodes", DEPOTS);
  const caregivers = countOf(sections, "nbVehi", 1);
  const serviceKinds = countOf(sections, "nbServi", 1);
  const required = sized(sections, "r", nodeCount * serviceKinds);
  sized(sections, "a", caregivers * serviceKinds);
  const xs = sized(sections, "x", nodeCount);
  const ys = sized(sections, "y", nodeCount);
  sized(sections, "d", nodeCount * nodeCount);
  const times = sized(sections, "p", nodeCount * caregivers * serviceKinds);
  const least = sized(sections, "mind", nodeCount);
  const most = sized(sections, "maxd", nodeCount);
  const earliest = sized(sections, "e", nodeCount);
  const latest = sized(sections, "l", nodeCount);
  const line = (name: SectionName): number => sections.get(name)?.line ?? 1;
  // DS numbers its nodes from one, where every other section's rows count from zero.
  const doubles = new Set(
    (sections.get("DS")?.values ?? []).map((number) => {
      if (!Number.isInteger(number) || number < 1 || number > nodeCount) {
        throw new NativeParseError(FORMAT, line("DS"), `the double service node ${String(number)} is not a node number from 1 to ${String(nodeCount)}`);
      }

      return number - 1;
    }),
  );
  const nodes: NativeRow[] = Array.from({ length: nodeCount }, (_, node) => {
    const at = (values: readonly number[]): number => cell(values, 1, node, 0);
    if (node === 0 || node === nodeCount - 1) {
      // The depot copies are marked as requiring every service and take no processing time, a convention of the format and not a visit, so they carry no services or durations.
      return { id: String(node), role: "depot", x: at(xs), y: at(ys), services: null, duration1: null, duration2: null, earliest: at(earliest), latest: at(latest), minGap: null, maxGap: null };
    }
    const services = Array.from({ length: serviceKinds }, (__, service) => service).filter((service) => {
      const flag = cell(required, serviceKinds, node, service);
      if (flag !== 0 && flag !== 1) {
        throw new NativeParseError(FORMAT, line("r"), `node ${String(node)} has the requirement ${String(flag)} for service ${String(service + 1)}, not 0 or 1`);
      }

      return flag === 1;
    });
    if (services.length > MOST_SERVICES || (doubles.has(node) && services.length !== MOST_SERVICES)) {
      throw new NativeParseError(FORMAT, line("r"), `node ${String(node)} requires ${String(services.length)} services${doubles.has(node) ? " but is a double service node" : ""}`);
    }
    const [first, second] = services.map((service) => {
      const byCaregiver = Array.from({ length: caregivers }, (__, caregiver) => cell(times, serviceKinds, node * caregivers + caregiver, service));
      const [time] = byCaregiver;
      if (time === undefined || byCaregiver.some((other) => other !== time)) {
        throw new NativeParseError(FORMAT, line("p"), `node ${String(node)} has processing times for service ${String(service + 1)} that differ between caregivers (${byCaregiver.join(", ")})`);
      }

      return time;
    });

    return {
      id: String(node),
      role: "patient",
      x: at(xs),
      y: at(ys),
      services: services.length === 0 ? null : services.map((service) => String(service + 1)).join(" "),
      duration1: first ?? null,
      duration2: second ?? null,
      earliest: at(earliest),
      latest: at(latest),
      minGap: doubles.has(node) ? at(least) : null,
      maxGap: doubles.has(node) ? at(most) : null,
    };
  });

  return { meta: { patients: nodeCount - DEPOTS, caregivers, serviceKinds }, nodes };
}
