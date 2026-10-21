import { unzipSync } from "fflate";
import { ArchiveError } from "../errors";
import { getOwn } from "../own";
import { BUILT_IN_DATE_FORMATS, isDateFormat, isoOf, type SheetGrid } from "./sheet";
import { attributesOf, elements, unescape } from "./xml-part";

const LETTERS = 26;
const FIRST_LETTER = "A".charCodeAt(0);

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
function readRows(xml: string, strings: readonly string[], dates: ReadonlySet<number>, date1904: boolean): SheetGrid {
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
 * The names of a workbook's sheets, in the order the workbook lists them, which is the order of the tabs an editor shows.
 * @param bytes - The workbook.
 * @returns The sheet names.
 * @throws ArchiveError when the bytes are not a workbook.
 */
export function sheetNames(bytes: Uint8Array): string[] {
  let part: Uint8Array | undefined;
  try {
    part = getOwn(
      unzipSync(bytes, { filter: (file) => file.name === "xl/workbook.xml" }),
      "xl/workbook.xml",
    );
  } catch (error) {
    throw new ArchiveError(`not a valid workbook: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (part === undefined) {
    throw new ArchiveError("the file is not an xlsx workbook: it has no xl/workbook.xml");
  }

  return elements(new TextDecoder("utf-8").decode(part), "sheet").map((sheet, index) => {
    const name = sheet["name"];
    if (name === undefined) {
      throw new ArchiveError(`the workbook's sheet ${String(index + 1)} has no name`);
    }

    return name;
  });
}

/**
 * Reads one sheet of an xlsx workbook: a date cell as ISO 8601 text (recognised by its cell style's number format, in either date system), a boolean as TRUE or FALSE, a number as the text the workbook stores, and a formula as its stored result.
 * @param bytes - The workbook.
 * @param sheet - The sheet's name.
 * @returns The sheet's cells.
 * @throws ArchiveError when the bytes are not a workbook, the sheet is missing, or a cell cannot be read.
 */
export function xlsxGrid(bytes: Uint8Array, sheet: string): SheetGrid {
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

  return readRows(new TextDecoder("utf-8").decode(sheetBytes), strings === undefined ? [] : sharedStrings(strings), dateStyles(text("xl/styles.xml")), /<workbookPr(?=[\s/>])[^>]*date1904="(?:1|true)"/.test(workbook));
}
