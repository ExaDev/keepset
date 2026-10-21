import { unzipSync } from "fflate";
import { ArchiveError } from "../errors";
import { getOwn } from "../own";
import type { SheetGrid } from "./sheet";
import { attributesOf, unescape } from "./xml-part";

/** The part of an OpenDocument spreadsheet that holds its tables ([ODF 1.3] part 2, 3.1.3). */
const CONTENT_PART = "content.xml";
const DECIMAL = 10;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
/** An `office:time-value`, an ISO 8601 duration of hours, minutes and seconds such as `PT13H05M00S` (the form spreadsheet applications write for a time of day, [ODF 1.3] part 3, 19.389). */
const TIME_VALUE = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/;
/** The value types whose value is the number in `office:value` ([ODF 1.3] part 3, 19.387). */
const NUMERIC_TYPES = new Set(["float", "percentage", "currency"]);

/**
 * The text of a cell's paragraphs, as a spreadsheet shows it: paragraphs joined by line breaks, `text:s` as its count of spaces, `text:tab` as a tab and `text:line-break` as a line break, the text of spans and links kept and annotations left out.
 * @param body - The XML between the cell's start and end tags.
 * @param row - The 1-based row, for the error.
 * @returns The text.
 * @throws ArchiveError when a run of spaces states a count that is not a positive whole number.
 */
function cellText(body: string, row: number): string {
  const paragraphs: string[] = [];
  for (const paragraph of body.replaceAll(/<office:annotation[\s>][\s\S]*?<\/office:annotation>/g, "").matchAll(/<text:(?:p|h)(?=[\s/>])[^>]*?(?:\/>|>([\s\S]*?)<\/text:(?:p|h)>)/g)) {
    const inner = (paragraph[1] ?? "")
      .replaceAll(/<text:s(?=[\s/>])([^>]*?)\/?>/g, (_whole, attributes: string) => " ".repeat(repeats(attributesOf(attributes), "text:c", row)))
      .replaceAll(/<text:tab(?=[\s/>])[^>]*?\/?>/g, "\t")
      .replaceAll(/<text:line-break(?=[\s/>])[^>]*?\/?>/g, "\n")
      .replaceAll(/<[^>]*>/g, "");
    paragraphs.push(unescape(inner));
  }

  return paragraphs.join("\n");
}

/**
 * A time value as the clock text the xlsx reader gives a time alone, `hh:mm:ss`, with the seconds rounded to whole seconds and an hour count past a day kept as it stands.
 * @param duration - The `office:time-value`.
 * @param row - The 1-based row, for the error.
 * @returns The text.
 * @throws ArchiveError when the value is not an hours, minutes and seconds duration.
 */
function timeText(duration: string, row: number): string {
  const match = TIME_VALUE.exec(duration);
  if (match === null) {
    throw new ArchiveError(`row ${String(row)} has a time cell holding ${duration}, which is not a duration of hours, minutes and seconds`);
  }
  const total = Math.round(Number.parseInt(match[1] ?? "0", DECIMAL) * MINUTES_PER_HOUR * SECONDS_PER_MINUTE + Number.parseInt(match[2] ?? "0", DECIMAL) * SECONDS_PER_MINUTE + Number(match[3] ?? "0"));

  return [Math.floor(total / (MINUTES_PER_HOUR * SECONDS_PER_MINUTE)), Math.floor(total / SECONDS_PER_MINUTE) % MINUTES_PER_HOUR, total % SECONDS_PER_MINUTE].map((part) => String(part).padStart(2, "0")).join(":");
}

/**
 * The text a cell gives the CSV, by its value type: the stored number for a number, percentage or currency, the stored ISO 8601 date (or date and time) for a date, `hh:mm:ss` for a time, TRUE or FALSE for a boolean, the shown text for a string or an error, and nothing for a cell with no value.
 * @param attributes - The cell's attributes.
 * @param body - The XML between its tags.
 * @param row - The 1-based row, for errors.
 * @returns The text, empty for no value.
 * @throws ArchiveError when a typed cell lacks the attribute its type stores its value in.
 */
function valueText(attributes: Readonly<Record<string, string>>, body: string, row: number): string {
  const type = attributes["office:value-type"];
  const stored = (name: string): string => {
    const value = attributes[name];
    if (value === undefined) {
      throw new ArchiveError(`row ${String(row)} has a ${type ?? ""} cell with no ${name}`);
    }

    return value;
  };
  // LibreOffice marks a formula that evaluated to an error with its own value type beside a placeholder number, and the error's text is what the cell shows.
  if (type === undefined || type === "string" || attributes["calcext:value-type"] === "error") {
    return cellText(body, row);
  }
  if (NUMERIC_TYPES.has(type)) {
    return stored("office:value");
  }
  if (type === "date") {
    return stored("office:date-value");
  }
  if (type === "time") {
    return timeText(stored("office:time-value"), row);
  }
  if (type === "boolean") {
    return stored("office:boolean-value") === "true" ? "TRUE" : "FALSE";
  }
  throw new ArchiveError(`row ${String(row)} has a cell of value type ${type}, which OpenDocument does not define`);
}

/**
 * How many times a row or cell repeats.
 * @param attributes - Its attributes.
 * @param name - The repeat attribute, which is absent for an element that appears once.
 * @param row - The 1-based row, for the error.
 * @returns The count, at least one.
 * @throws ArchiveError when the attribute is not a positive whole number.
 */
function repeats(attributes: Readonly<Record<string, string>>, name: string, row: number): number {
  const stated = attributes[name];
  if (stated === undefined) {
    return 1;
  }
  if (!/^[1-9]\d*$/.test(stated)) {
    throw new ArchiveError(`row ${String(row)} states ${name} as ${stated}, which is not a positive whole number`);
  }

  return Number(stated);
}

/**
 * Reads one table of an OpenDocument spreadsheet (`.ods`, a zip of XML parts) as the same text the xlsx reader gives (see `valueText`). A cell or row repeated by `table:number-columns-repeated` or `table:number-rows-repeated` is written as often as it repeats when it holds a value; an empty one only moves the position on, so the filler an application writes to the end of the sheet costs nothing. A covered cell (the hidden part of a merged range) is an empty cell.
 * @param bytes - The spreadsheet.
 * @param sheet - The table's name.
 * @returns The table's cells.
 * @throws ArchiveError when the bytes are not an OpenDocument spreadsheet, the table is missing, or a cell is malformed.
 */
export function odsGrid(bytes: Uint8Array, sheet: string): SheetGrid {
  let content: Uint8Array | undefined;
  try {
    content = getOwn(
      unzipSync(bytes, { filter: (file) => file.name === CONTENT_PART }),
      CONTENT_PART,
    );
  } catch (error) {
    throw new ArchiveError(`not a valid OpenDocument spreadsheet: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (content === undefined) {
    throw new ArchiveError(`the file is not an OpenDocument spreadsheet: it has no ${CONTENT_PART}`);
  }
  const xml = new TextDecoder("utf-8", { fatal: true }).decode(content);
  const names: string[] = [];
  let table: string | undefined;
  for (const match of xml.matchAll(/<table:table(?=[\s>])([^>]*)>([\s\S]*?)<\/table:table>/g)) {
    const name = attributesOf(match[1] ?? "")["table:name"] ?? "";
    names.push(name);
    if (name === sheet) {
      table = match[2] ?? "";
      break;
    }
  }
  if (table === undefined) {
    throw new ArchiveError(`the spreadsheet has no table ${sheet}; it has ${names.join(", ")}`);
  }

  const rows = new Map<number, (string | undefined)[]>();
  let width = 0;
  let next = 1;
  for (const row of table.matchAll(/<table:table-row(?=[\s/>])([^>]*?)(?:\/>|>([\s\S]*?)<\/table:table-row>)/g)) {
    const repeated = repeats(attributesOf(row[1] ?? ""), "table:number-rows-repeated", next);
    const cells: string[] = [];
    let column = 0;
    for (const cell of (row[2] ?? "").matchAll(/<table:(?:covered-)?table-cell(?=[\s/>])([^>]*?)(?:\/>|>([\s\S]*?)<\/table:(?:covered-)?table-cell>)/g)) {
      const attributes = attributesOf(cell[1] ?? "");
      const span = repeats(attributes, "table:number-columns-repeated", next);
      const text = valueText(attributes, cell[2] ?? "", next);
      if (text !== "") {
        for (let copy = 0; copy < span; copy += 1) {
          cells[column + copy] = text;
        }
        width = Math.max(width, column + span);
      }
      column += span;
    }
    if (cells.length > 0) {
      for (let copy = 0; copy < repeated; copy += 1) {
        rows.set(next + copy, cells);
      }
    }
    next += repeated;
  }

  return { rows, width };
}
