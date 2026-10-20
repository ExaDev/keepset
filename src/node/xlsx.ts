import { unzipSync } from "fflate";
import { ArchiveError } from "../errors";
import { getOwn } from "../own";
import { csvField } from "./csv-text";

const HEXADECIMAL = 16;
const DECIMAL = 10;
const LETTERS = 26;
const FIRST_LETTER = "A".charCodeAt(0);
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

/** One element's attributes, by name with any namespace prefix kept (`r:id`). */
type Attributes = Readonly<Record<string, string>>;

/**
 * Replaces the XML entities and character references of a text.
 * @param text - Escaped text.
 * @returns The text.
 */
function unescape(text: string): string {
  return text.replaceAll(/&(#x[0-9A-Fa-f]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_whole, entity: string) => {
    if (entity.startsWith("#x")) {
      return String.fromCodePoint(Number.parseInt(entity.slice(2), HEXADECIMAL));
    }
    if (entity.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(entity.slice(1), DECIMAL));
    }

    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[entity] ?? "";
  });
}

/**
 * The attributes of a start tag's text.
 * @param tag - The text between `<` and `>`, name included.
 * @returns The attributes, unescaped.
 */
function attributesOf(tag: string): Attributes {
  const attributes: Record<string, string> = {};
  for (const [, name, value] of tag.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) {
    if (name !== undefined && value !== undefined) {
      attributes[name] = unescape(value);
    }
  }

  return attributes;
}

/**
 * The start tags of one element name in an XML part, in order.
 * @param xml - The part's text.
 * @param name - The element name.
 * @returns The attributes of each start tag.
 */
function elements(xml: string, name: string): Attributes[] {
  return [...xml.matchAll(new RegExp(`<${name}(?=[\\s/>])([^>]*)>`, "g"))].map((match) => attributesOf(match[1] ?? ""));
}

/**
 * The strings of a workbook's shared string table, in index order: each item's text runs joined, the phonetic runs of East Asian text left out.
 * @param xml - The `sharedStrings.xml` text.
 * @returns The strings.
 */
function sharedStrings(xml: string): string[] {
  return [...xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map((item) => {
    const runs = (item[1] ?? "").replaceAll(/<rPh[\s\S]*?<\/rPh>/g, "");

    return [...runs.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((text) => unescape(text[1] ?? "")).join("");
  });
}

/** The built-in number format ids that show a date or a time, as inclusive ranges (ECMA-376, 18.8.30): the short and long dates and times, the locale dates, and the elapsed and minute times. */
const BUILT_IN_DATE_FORMATS = [
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
function isDateFormat(code: string): boolean {
  return /[ymdhs]/i.test(code.replaceAll(/"[^"]*"|\\.|\[[^\]]*\]/g, ""));
}

/**
 * Which cell styles show dates, by the style's index.
 * @param xml - The `styles.xml` text, or undefined when the workbook has none.
 * @returns The style indexes whose number format is a date or a time.
 */
function dateStyles(xml: string | undefined): ReadonlySet<number> {
  if (xml === undefined) {
    return new Set();
  }
  const custom = new Map<number, string>();
  for (const format of elements(xml, "numFmt")) {
    if (format["numFmtId"] !== undefined && format["formatCode"] !== undefined) {
      custom.set(Number(format["numFmtId"]), format["formatCode"]);
    }
  }
  const cellFormats = /<cellXfs(?:\s[^>]*)?>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? "";
  const styles = new Set<number>();
  for (const [index, format] of elements(cellFormats, "xf").entries()) {
    const id = Number(format["numFmtId"] ?? "0");
    const code = custom.get(id);
    if (code === undefined ? BUILT_IN_DATE_FORMATS.some((range) => id >= range.first && id <= range.last) : isDateFormat(code)) {
      styles.add(index);
    }
  }

  return styles;
}

/**
 * A date serial number as ISO 8601 text: a date when it has no time of day, a date and time when it has, and a time alone for a serial below one day in a 1900 workbook.
 * @param serial - The serial number, with the time of day as its fraction.
 * @param date1904 - Whether the workbook counts days from 1 January 1904.
 * @returns The text.
 * @throws ArchiveError for the serial of the 29th of February 1900, which is not a date.
 */
function isoOf(serial: number, date1904: boolean): string {
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

/**
 * The 0-based column of a cell reference such as `AB12`.
 * @param reference - The reference.
 * @returns The column index.
 */
function columnOf(reference: string): number {
  let index = 0;
  for (const letter of reference.replaceAll(/[^A-Za-z]/g, "")) {
    index = index * LETTERS + (letter.toUpperCase().charCodeAt(0) - FIRST_LETTER + 1);
  }

  return index - 1;
}

/**
 * Finds the part that holds a named sheet.
 * @param workbook - The `workbook.xml` text.
 * @param rels - The workbook's relationships text.
 * @param name - The sheet's name.
 * @returns The part's path inside the archive.
 * @throws ArchiveError when the workbook has no such sheet or its relationship is missing.
 */
function sheetPath(workbook: string, rels: string, name: string): string {
  const sheets = elements(workbook, "sheet");
  const wanted = sheets.find((sheet) => sheet["name"] === name);
  if (wanted === undefined) {
    throw new ArchiveError(`the workbook has no sheet ${name}; it has ${sheets.map((sheet) => sheet["name"] ?? "").join(", ")}`);
  }
  const target = elements(rels, "Relationship").find((relation) => relation["Id"] === wanted["r:id"])?.["Target"];
  if (target === undefined) {
    throw new ArchiveError(`the workbook has no relationship for the sheet ${name}`);
  }

  return target.startsWith("/") ? target.slice(1) : `xl/${target}`;
}

/**
 * Reads a worksheet's cells into text by row and column.
 * @param xml - The worksheet's text.
 * @param strings - The shared strings.
 * @param dates - The date styles.
 * @param date1904 - Whether the workbook counts days from 1 January 1904.
 * @returns The rows by 1-based row number, each a sparse list of the cells' text, and the widest row's column count.
 * @throws ArchiveError when a cell names a shared string the workbook lacks or a date cell holds no number.
 */
function readRows(xml: string, strings: readonly string[], dates: ReadonlySet<number>, date1904: boolean): { readonly rows: ReadonlyMap<number, string[]>; readonly width: number } {
  const rows = new Map<number, string[]>();
  let width = 0;
  let next = 1;
  for (const row of xml.matchAll(/<row(?=[\s>])([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const number = Number(attributesOf(row[1] ?? "")["r"] ?? next);
    next = number + 1;
    const cells: string[] = [];
    for (const cell of (row[2] ?? "").matchAll(/<c(?=[\s>])([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attributes = attributesOf(cell[1] ?? "");
      const column = attributes["r"] === undefined ? cells.length : columnOf(attributes["r"]);
      const body = cell[2] ?? "";
      const value = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let text: string | undefined;
      if (attributes["t"] === "inlineStr") {
        text = [...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((run) => unescape(run[1] ?? "")).join("");
      } else if (value === undefined) {
        text = undefined;
      } else if (attributes["t"] === "s") {
        text = strings[Number(value)];
        if (text === undefined) {
          throw new ArchiveError(`row ${String(number)} names the shared string ${value}, which the workbook does not have`);
        }
      } else if (attributes["t"] === "b") {
        text = value === "0" ? "FALSE" : "TRUE";
      } else if (attributes["t"] === "str" || attributes["t"] === "e") {
        text = unescape(value);
      } else if (dates.has(Number(attributes["s"] ?? "0"))) {
        const serial = Number(value);
        if (!Number.isFinite(serial) || serial < 0) {
          throw new ArchiveError(`row ${String(number)} has a date cell holding ${value}`);
        }
        text = isoOf(serial, date1904);
      } else {
        text = unescape(value);
      }
      if (text !== undefined && text !== "") {
        cells[column] = text;
        width = Math.max(width, column + 1);
      }
    }
    rows.set(number, cells);
  }

  return { rows, width };
}

/**
 * Writes one sheet of an xlsx workbook as CSV text, so a recipe reads it with the table parser: one line for every row number from the first to the last (a row the sheet leaves out is an empty line, so the lines above the header are the rows an editor shows), every line the width of the sheet's widest row, a date cell as ISO 8601 text, a boolean as TRUE or FALSE, a number as the text the workbook stores, and a formula as its stored result.
 * @param bytes - The workbook.
 * @param sheet - The sheet's name.
 * @returns The CSV, in UTF-8.
 * @throws ArchiveError when the bytes are not a workbook, the sheet is missing, or a cell cannot be read.
 */
export function sheetToCsv(bytes: Uint8Array, sheet: string): Uint8Array {
  let parts: Readonly<Record<string, Uint8Array>>;
  try {
    const wanted = new Set(["xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/sharedStrings.xml", "xl/styles.xml"]);
    parts = unzipSync(bytes, { filter: (file) => wanted.has(file.name) });
  } catch (error) {
    throw new ArchiveError(`not a valid workbook: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const text = (path: string): string | undefined => {
    const part = getOwn(parts, path);

    return part === undefined ? undefined : new TextDecoder("utf-8").decode(part);
  };
  const workbook = text("xl/workbook.xml");
  const rels = text("xl/_rels/workbook.xml.rels");
  if (workbook === undefined || rels === undefined) {
    throw new ArchiveError("the file is not an xlsx workbook: it has no xl/workbook.xml with its relationships");
  }
  const path = sheetPath(workbook, rels, sheet);
  const sheetBytes = getOwn(unzipSync(bytes, { filter: (file) => file.name === path }), path);
  if (sheetBytes === undefined) {
    throw new ArchiveError(`the workbook names the sheet ${sheet} in ${path}, which the file does not have`);
  }
  const strings = text("xl/sharedStrings.xml");
  const { rows, width } = readRows(new TextDecoder("utf-8").decode(sheetBytes), strings === undefined ? [] : sharedStrings(strings), dateStyles(text("xl/styles.xml")), /<workbookPr(?=[\s/>])[^>]*date1904="(?:1|true)"/.test(workbook));
  const last = Math.max(0, ...rows.keys());
  const lines: string[] = [];
  for (let number = 1; number <= last; number += 1) {
    const cells = rows.get(number) ?? [];
    lines.push(Array.from({ length: width }, (_empty, column) => csvField(cells[column] ?? "")).join(","));
  }

  return new TextEncoder().encode(lines.length === 0 ? "" : `${lines.join("\n")}\n`);
}
