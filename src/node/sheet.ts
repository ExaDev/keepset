import { ArchiveError } from "../errors";
import { csvField } from "./csv-text";

/** What the spreadsheet readers (`xlsx`, `xls` and `ods`) share: the date arithmetic of the Excel serial number, the test for a number format that shows a date, and the CSV a sheet is written as, so the three formats give the table parser the same text for the same cells. */

const SECONDS_PER_DAY = 86_400;
const MILLISECONDS = 1000;
/** The serial number Excel gives its 29th of February 1900, a day that never existed: serials above it count from 30 December 1899 and serials below it from 31 December 1899. */
const LEAP_BUG_SERIAL = 60;
/** The day a serial number counts from: 1 January 1904 in a workbook that says so, otherwise 31 December 1899 for the serials before Excel's false 29th of February 1900 and 30 December 1899 for those after it. */
const EPOCH_1904 = "1904-01-01T00:00:00Z";
const EPOCH_BEFORE_LEAP_BUG = "1899-12-31T00:00:00Z";
const EPOCH_AFTER_LEAP_BUG = "1899-12-30T00:00:00Z";
const DATE_LENGTH = "2000-01-01".length;
const DATE_TIME_LENGTH = "2000-01-01T00:00:00".length;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;

/** The built-in number format ids that show a date or a time, as inclusive ranges (ECMA-376, 18.8.30): the short and long dates and times, the locale dates, and the elapsed and minute times. */
export const BUILT_IN_DATE_FORMATS = [
  { first: 14, last: 22 },
  { first: 27, last: 36 },
  { first: 45, last: 47 },
  { first: 50, last: 58 },
] as const;

/**
 * Whether a custom number format shows a date or a time: it names a year, month, day, hour or second once its quoted text, escaped characters and bracketed conditions and colours are removed.
 * @param code - The format code.
 * @returns True for a date or time format.
 */
export function isDateFormat(code: string): boolean {
  return /[ymdhs]/i.test(code.replaceAll(/"[^"]*"|\\.|\[[^\]]*\]/g, ""));
}

/**
 * A date serial number as ISO 8601 text: a date when it has no time of day, a date and time when it has, and a time alone for a serial below one day in a 1900 workbook.
 * @param serial - The serial number, with the time of day as its fraction.
 * @param date1904 - Whether the workbook counts days from 1 January 1904.
 * @returns The text.
 * @throws ArchiveError for the serial of the 29th of February 1900, which is not a date.
 */
export function isoOf(serial: number, date1904: boolean): string {
  const whole = Math.floor(serial);
  const seconds = Math.round((serial - whole) * SECONDS_PER_DAY);
  if (!date1904 && whole === 0) {
    const clock = [Math.floor(seconds / (SECONDS_PER_MINUTE * MINUTES_PER_HOUR)), Math.floor(seconds / SECONDS_PER_MINUTE) % MINUTES_PER_HOUR, seconds % SECONDS_PER_MINUTE];

    return clock.map((part) => String(part).padStart(2, "0")).join(":");
  }
  if (!date1904 && whole === LEAP_BUG_SERIAL) {
    throw new ArchiveError("a cell holds the serial of 29 February 1900, which is not a date");
  }
  const epoch = Date.parse(date1904 ? EPOCH_1904 : whole < LEAP_BUG_SERIAL ? EPOCH_BEFORE_LEAP_BUG : EPOCH_AFTER_LEAP_BUG);
  const stamp = new Date(epoch + (whole * SECONDS_PER_DAY + seconds) * MILLISECONDS).toISOString();

  return stamp.slice(0, seconds === 0 ? DATE_LENGTH : DATE_TIME_LENGTH);
}

/** A sheet's cells as the text the CSV writes for them: each row by its 1-based row number, a sparse list of its non-empty cells' text by 0-based column, and the column count of the widest row. A row the map leaves out, or whose list holds no cell, holds no value. */
export interface SheetGrid {
  readonly rows: ReadonlyMap<number, readonly (string | undefined)[]>;
  readonly width: number;
}

/**
 * Writes a sheet's cells as CSV text, so a recipe reads every spreadsheet format with the table parser: one line for every row number from the first to the last row that holds a value (a row with no value before it is an empty line, so the lines above the header are the rows an editor shows, and the formatted but empty rows a sheet carries after its data are left out), every line the width of the widest row.
 * @param grid - The sheet's cells.
 * @returns The CSV, in UTF-8.
 */
export function gridToCsv(grid: SheetGrid): Uint8Array {
  let last = 0;
  for (const [number, cells] of grid.rows) {
    if (cells.length > 0) {
      last = Math.max(last, number);
    }
  }
  const lines: string[] = [];
  for (let number = 1; number <= last; number += 1) {
    const cells = grid.rows.get(number) ?? [];
    lines.push(Array.from({ length: grid.width }, (_empty, column) => csvField(cells[column] ?? "")).join(","));
  }

  return new TextEncoder().encode(lines.length === 0 ? "" : `${lines.join("\n")}\n`);
}
