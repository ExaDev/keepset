import { NativeParseError } from "../errors";
import { csvGrid } from "./csv-table";
import type { NativeInstance, NativeRow } from "./native";

/** The columns of a node of a home health care routing sheet, as the parser names them: whether it is the care centre or a patient, its position, the services it requires, the durations of its first and second required service, and the opening and closing of its first and second time window. */
export const HHCRSP_COLUMNS = ["role", "x", "y", "services", "duration1", "duration2", "earliest1", "latest1", "earliest2", "latest2"] as const;

/** The columns whose values are text; the others are numbers. */
export const HHCRSP_TEXT_COLUMNS = ["role", "services"] as const;

/** The metadata keys the parser reads: how many patients, caregivers and kinds of service the instance has. */
export const HHCRSP_META = ["patients", "caregivers", "serviceKinds"] as const;

const FORMAT = "hhcrsp";

/** The labels of the sheet's blocks, each the top-left cell of a block whose header runs to its right and whose rows run below it. */
const LABEL = { patients: "Patients", requests: "Pat / Ser", times: "P/SerTime", skills: "CgSkills", caregiverWindows: "TwCaregivers", patientWindows: "Tw Patients" } as const;

/** A service's header, `Service <k>`, a patient's row label and a caregiver's. */
const SERVICE = /^Service (\d+)$/;
const NUMBER = /^-?\d+(?:\.\d+)?$/;
/** How many required services a patient may have: the instances ask for one, or two that must be synchronised, and the parser has a duration column for each. */
const MOST_SERVICES = 2;

/** One block of the sheet: where its label sits, its header cells, and its rows as their label and the cells under the header. */
interface Block {
  readonly line: number;
  readonly column: number;
  readonly header: readonly string[];
  readonly rows: readonly { readonly line: number; readonly label: string; readonly cells: readonly string[] }[];
}

/**
 * Finds a block by its label: the one cell of the sheet that holds it, its header the cells to its right up to the first empty one, and its rows those below it up to the first whose label and cells are all empty. Past its header a block has an empty column, so the cell there must be empty in every row and a value the header does not label is refused rather than left unread; `Pat / Ser` instead keeps its count there, with the next block starting right after it, and its count is checked on its own.
 * @param grid - The sheet's cells by row.
 * @param label - The block's label.
 * @param pastHeader - What the column past the header holds: nothing, or the block's count.
 * @returns The block.
 * @throws NativeParseError when the label is in no cell or in more than one, or a row has a value in the empty column past the header.
 */
function blockOf(grid: readonly (readonly string[])[], label: string, pastHeader: "empty" | "count" = "empty"): Block {
  const found = grid.flatMap((row, line) => row.flatMap((cell, column) => (cell.trim() === label ? [{ line, column }] : [])));
  const [only] = found;
  if (only === undefined || found.length !== 1) {
    throw new NativeParseError(FORMAT, 1, `expected one block labelled ${JSON.stringify(label)}, found ${String(found.length)}`);
  }
  const headerRow = grid[only.line] ?? [];
  const end = headerRow.findIndex((cell, column) => column > only.column && cell.trim() === "");
  const header = headerRow.slice(only.column + 1, end === -1 ? headerRow.length : end).map((cell) => cell.trim());
  const rows: Block["rows"][number][] = [];
  for (let line = only.line + 1; line < grid.length; line += 1) {
    const cells = (grid[line] ?? []).slice(only.column, only.column + 1 + header.length).map((cell) => cell.trim());
    if (cells.every((cell) => cell === "")) {
      break;
    }
    const past = (grid[line] ?? [])[only.column + 1 + header.length]?.trim();
    if (pastHeader === "empty" && past !== undefined && past !== "") {
      throw new NativeParseError(FORMAT, line + 1, `the ${label} block's row holds ${JSON.stringify(past)} past its header ${JSON.stringify(header)}, which does not label it`);
    }
    rows.push({ line: line + 1, label: cells[0] ?? "", cells: cells.slice(1) });
  }

  return { line: only.line + 1, column: only.column, header, rows };
}

/**
 * Reads a cell as a finite number.
 * @param cell - The trimmed cell.
 * @param line - The 1-based line, for the error.
 * @param what - What the cell should be, for the error.
 * @returns The number.
 * @throws NativeParseError when the cell is not a decimal number.
 */
function numberOf(cell: string | undefined, line: number, what: string): number {
  if (cell === undefined || !NUMBER.test(cell)) {
    throw new NativeParseError(FORMAT, line, `expected ${what}, found ${JSON.stringify(cell)}`);
  }

  return Number(cell);
}

/**
 * Checks that a block's rows are labelled `<noun> 1` to `<noun> <count>` in order.
 * @param block - The block.
 * @param noun - The row label's word.
 * @param label - The block's label, for the error.
 * @throws NativeParseError naming the first row out of order.
 */
function checkNumbered(block: Block, noun: string, label: string): void {
  block.rows.forEach((row, index) => {
    if (row.label !== `${noun} ${String(index + 1)}`) {
      throw new NativeParseError(FORMAT, row.line, `the ${label} block's row ${String(index + 1)} is labelled ${JSON.stringify(row.label)}, not ${noun} ${String(index + 1)}`);
    }
  });
}

/**
 * Checks that a block's header names the services 1 to k in order.
 * @param block - The block.
 * @param label - The block's label, for the error.
 * @returns The number of services, k.
 * @throws NativeParseError when a header cell is not the next service.
 */
function serviceCount(block: Block, label: string): number {
  block.header.forEach((cell, index) => {
    if (SERVICE.exec(cell)?.[1] !== String(index + 1)) {
      throw new NativeParseError(FORMAT, block.line, `the ${label} block's header cell ${String(index + 1)} is ${JSON.stringify(cell)}, not Service ${String(index + 1)}`);
    }
  });

  return block.header.length;
}

/**
 * Parses one sheet of a home health care routing and scheduling workbook (the layout of Bazirha's multiple-time-window, multiple-service instances, generated from Mankowska et al. 2014), read as the CSV of the sheet. The sheet holds labelled blocks side by side: `Patients` gives each node's X and Y, the care centre as node 0 first and again as the last row (the route's end, which must repeat the centre's position); `Pat / Ser` marks which of the services each patient requires with a 1 (a 0 or an empty cell is a service not required) and counts them in the column after the services, and the count must agree with the marks; `P/SerTime` gives each patient's duration for every service, after a row of zeros for the centre whose label may be empty; `CgSkills` and `TwCaregivers` give the caregivers' skills and working windows; and `Tw Patients` gives each patient's time windows by the headers `ETW 1` and `LTW 1`, and `ETW 2` and `LTW 2` where there is a second, in whatever order the sheet puts them. The travel time block, the caregivers' skills and their windows are not carried, since tasks/v1 has neither arcs nor resources: the caregivers are counted in `meta`. The sheets name no unit for their times.
 * @param text - The sheet's CSV text.
 * @returns The instance: its patient, caregiver and service counts as `meta`, and its nodes, the centre (id `0`) first and the patients (ids `1` to n) after it. A patient's `services` names its required services joined by a comma and a space (`Service 1, Service 5`), and its `duration1` and `duration2` are those services' durations in that order.
 * @throws NativeParseError when a block is missing or repeated, its rows or header are not the numbered patients, caregivers or services it should hold, the blocks disagree on the number of patients or caregivers, the centre's closing row does not repeat it, a patient requires no service or more than two, a requirement is not 0, 1 or empty or the count beside the marks disagrees with them, or a cell that should be a number is not.
 */
export function parseHhcrsp(text: string): NativeInstance {
  const grid = csvGrid(text);
  const positions = blockOf(grid, LABEL.patients);
  const requests = blockOf(grid, LABEL.requests, "count");
  const times = blockOf(grid, LABEL.times);
  const skills = blockOf(grid, LABEL.skills);
  const caregiverWindows = blockOf(grid, LABEL.caregiverWindows);
  const windows = blockOf(grid, LABEL.patientWindows);
  const serviceKinds = serviceCount(requests, LABEL.requests);
  if (serviceCount(times, LABEL.times) !== serviceKinds || serviceCount(skills, LABEL.skills) !== serviceKinds) {
    throw new NativeParseError(FORMAT, times.line, `the ${LABEL.requests}, ${LABEL.times} and ${LABEL.skills} blocks name different numbers of services`);
  }
  checkNumbered(requests, "Patient", LABEL.requests);
  checkNumbered(windows, "Patient", LABEL.patientWindows);
  checkNumbered(skills, "Caregiver", LABEL.skills);
  checkNumbered(caregiverWindows, "Caregiver", LABEL.caregiverWindows);
  const patients = requests.rows.length;
  const [centreTimes, ...patientTimes] = times.rows;
  checkNumbered({ ...times, rows: patientTimes }, "Patient", LABEL.times);
  if (centreTimes === undefined || !["", "center", "centre"].includes(centreTimes.label.toLowerCase()) || windows.rows.length !== patients || patientTimes.length !== patients || skills.rows.length !== caregiverWindows.rows.length) {
    throw new NativeParseError(FORMAT, requests.line, `the blocks disagree: ${String(patients)} patients requesting services, ${String(patientTimes.length)} with durations after the centre's row, ${String(windows.rows.length)} with time windows, and ${String(skills.rows.length)} caregivers with skills against ${String(caregiverWindows.rows.length)} with windows`);
  }
  if (positions.header.join(",") !== "X,Y" || positions.rows.length !== patients + 2 || positions.rows.some((row, index) => row.label !== String(index))) {
    throw new NativeParseError(FORMAT, positions.line, `the ${LABEL.patients} block must give X and Y for nodes 0 to ${String(patients + 1)}, the centre, ${String(patients)} patients and the centre again`);
  }
  const position = (index: number): { readonly x: number; readonly y: number; readonly line: number } => {
    const row = positions.rows[index];
    if (row === undefined) {
      throw new NativeParseError(FORMAT, positions.line, `the ${LABEL.patients} block has no node ${String(index)}`);
    }

    return { x: numberOf(row.cells[0], row.line, "an X"), y: numberOf(row.cells[1], row.line, "a Y"), line: row.line };
  };
  const { x, y } = position(0);
  const closing = position(patients + 1);
  if (closing.x !== x || closing.y !== y) {
    throw new NativeParseError(FORMAT, closing.line, `the last node of the ${LABEL.patients} block is not at the centre's position, so it is not the route's end`);
  }
  const windowColumn = (name: string): number | undefined => {
    const index = windows.header.indexOf(name);

    return index === -1 ? undefined : index;
  };
  const columns = { earliest1: windowColumn("ETW 1"), latest1: windowColumn("LTW 1"), earliest2: windowColumn("ETW 2"), latest2: windowColumn("LTW 2") };
  if (columns.earliest1 === undefined || columns.latest1 === undefined || (columns.earliest2 === undefined) !== (columns.latest2 === undefined) || windows.header.length !== (columns.earliest2 === undefined ? 2 : 2 * 2)) {
    throw new NativeParseError(FORMAT, windows.line, `the ${LABEL.patientWindows} header ${JSON.stringify(windows.header)} is not ETW 1 and LTW 1, with or without ETW 2 and LTW 2`);
  }
  const nodes: NativeRow[] = [{ id: "0", role: "centre", x, y, services: null, duration1: null, duration2: null, earliest1: null, latest1: null, earliest2: null, latest2: null }];
  requests.rows.forEach((request, index) => {
    const required = request.cells.flatMap((cell, service) => {
      if (cell !== "0" && cell !== "1" && cell !== "") {
        throw new NativeParseError(FORMAT, request.line, `${request.label} has ${JSON.stringify(cell)} for Service ${String(service + 1)}, not 0, 1 or empty`);
      }

      return cell === "1" ? [service] : [];
    });
    const stated = (grid[request.line - 1] ?? [])[requests.column + serviceKinds + 1]?.trim();
    if (stated !== String(required.length)) {
      throw new NativeParseError(FORMAT, request.line, `${request.label} requires ${String(required.length)} services by its marks, and the count beside them is ${JSON.stringify(stated)}`);
    }
    if (required.length === 0 || required.length > MOST_SERVICES) {
      throw new NativeParseError(FORMAT, request.line, `${request.label} requires ${String(required.length)} services, and a patient requires one or two`);
    }
    const timeRow = patientTimes[index];
    const windowRow = windows.rows[index];
    if (timeRow === undefined || windowRow === undefined) {
      throw new NativeParseError(FORMAT, request.line, `${request.label} has no durations or time windows`);
    }
    const duration = (which: number): number | null => {
      const service = required[which];

      return service === undefined ? null : numberOf(timeRow.cells[service], timeRow.line, `the duration of Service ${String(service + 1)}`);
    };
    const window = (column: number | undefined, what: string): number | null => (column === undefined ? null : numberOf(windowRow.cells[column], windowRow.line, what));
    const at = position(index + 1);
    nodes.push({
      id: String(index + 1),
      role: "patient",
      x: at.x,
      y: at.y,
      services: required.map((service) => `Service ${String(service + 1)}`).join(", "),
      duration1: duration(0),
      duration2: duration(1),
      earliest1: window(columns.earliest1, "the opening of the first window"),
      latest1: window(columns.latest1, "the closing of the first window"),
      earliest2: window(columns.earliest2, "the opening of the second window"),
      latest2: window(columns.latest2, "the closing of the second window"),
    });
  });

  return { meta: { patients, caregivers: skills.rows.length, serviceKinds }, nodes };
}
