import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import type { NativeRow, NativeTable } from "./native";

type CsvTableParser = Extract<Parser, { format: "csv-table" }>;

/** The character each delimiter option splits fields on. */
const DELIMITERS: Readonly<Record<CsvTableParser["delimiter"], string>> = { comma: ",", tab: "\t", semicolon: ";" };

/** A number as a decimal literal, with an optional sign and exponent. `Number` alone would also accept hex, binary, `Infinity` and the empty string. */
const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** The byte order mark some exporters put before the first header. */
const BYTE_ORDER_MARK = "﻿";

/**
 * The name the parser gives a column: the header with every run of characters outside letters, digits and underscore replaced by one underscore, leading and trailing underscores dropped, and a name starting with a digit prefixed with `c_`. A header with nothing left (an empty cell, as in a table exported with an unnamed index column) is `column_` and its 1-based position. The rule depends on the header and its position alone, so a crosswalk written against a file's headers reads the same wherever it runs.
 * @param header - A header cell.
 * @param position - The cell's 1-based position among the header cells.
 * @returns The column name.
 */
export function columnName(header: string, position: number): string {
  const name = header
    .trim()
    .replaceAll(/[^A-Za-z0-9_]+/g, "_")
    .replaceAll(/^_+|_+$/g, "");
  if (name === "") {
    return `column_${String(position)}`;
  }

  return /^\d/.test(name) ? `c_${name}` : name;
}

/** One record of the file: its fields and the 1-based line it starts on. */
interface CsvRecord {
  readonly line: number;
  readonly fields: readonly string[];
}

/**
 * Splits text into records and fields by RFC 4180: a field may be quoted, a quoted field may hold the delimiter, line breaks and doubled quotes, and a record ends at an unquoted LF, CRLF or CR.
 * @param text - The file text, after the lines the recipe skips.
 * @param delimiter - The field delimiter.
 * @param firstLine - The 1-based line of the file the text starts on.
 * @returns The records, blank lines included as a record of one empty field.
 * @throws NativeParseError when a quoted field is never closed or a quote opens inside an unquoted field.
 */
function records(text: string, delimiter: string, firstLine: number): CsvRecord[] {
  const out: CsvRecord[] = [];
  let fields: string[] = [];
  let field = "";
  let quoted = false;
  let started = firstLine;
  let line = firstLine;
  let index = 0;
  const endRecord = (): void => {
    fields.push(field);
    out.push({ line: started, fields });
    fields = [];
    field = "";
    started = line;
  };
  while (index < text.length) {
    const char = text.charAt(index);
    if (quoted) {
      if (char === '"') {
        if (text.charAt(index + 1) === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        if (char === "\n") {
          line += 1;
        }
        field += char;
      }
    } else if (char === '"') {
      if (field !== "") {
        throw new NativeParseError("csv-table", line, "a quote opens inside an unquoted field");
      }
      quoted = true;
    } else if (char === delimiter) {
      fields.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text.charAt(index + 1) === "\n") {
        index += 1;
      }
      line += 1;
      endRecord();
    } else {
      field += char;
    }
    index += 1;
  }
  if (quoted) {
    throw new NativeParseError("csv-table", started, "a quoted field is never closed");
  }
  if (field !== "" || fields.length > 0) {
    endRecord();
  }

  return out;
}

/**
 * Drops the first lines of a file.
 * @param text - The file text.
 * @param count - How many physical lines to drop.
 * @returns The rest of the text.
 * @throws NativeParseError when the file has fewer lines than that.
 */
function afterLines(text: string, count: number): string {
  let index = 0;
  for (let dropped = 0; dropped < count; dropped += 1) {
    const next = text.slice(index).search(/\n/);
    if (next === -1) {
      throw new NativeParseError("csv-table", dropped + 1, `the file has fewer than ${String(count)} lines to skip before the header`);
    }
    index += next + 1;
  }

  return text.slice(index);
}

/**
 * Reads a numeric cell.
 * @param cell - The trimmed cell.
 * @param factor - What the recipe multiplies the value by, to put it in the target's unit.
 * @param column - The column, for the error.
 * @param line - The 1-based line, for the error.
 * @returns The number, or null for an empty cell.
 * @throws NativeParseError when the cell is not a decimal number.
 */
function numeric(cell: string, factor: number, column: string, line: number): number | null {
  if (cell === "") {
    return null;
  }
  if (!DECIMAL.test(cell)) {
    throw new NativeParseError("csv-table", line, `column ${column} is declared numeric but holds ${JSON.stringify(cell)}`);
  }

  return Number(cell) * factor;
}

/**
 * Parses a delimited table into rows: the first record after `skipLines` lines is the header, each later record is a row, and every row carries every column but the id column, an empty cell being null. Cells are trimmed. A column the recipe declares numeric is read as a decimal number times its factor and any other column stays a string. `id` is the row's id, so a column of that name which is not the id column is named by its position. A row's id is the cell of the recipe's id column, which is then not also a column, or its 1-based row number when the recipe names none. Blank lines are skipped; a row with a different number of fields than the header, two columns with the same name, and an id cell that is empty are errors.
 * @param text - The file text.
 * @param options - The recipe's table parser.
 * @returns The rows, in file order.
 * @throws NativeParseError naming the line of the first problem.
 */
export function parseCsvTable(text: string, options: CsvTableParser): NativeTable {
  const body = afterLines(text.startsWith(BYTE_ORDER_MARK) ? text.slice(BYTE_ORDER_MARK.length) : text, options.skipLines);
  const [header, ...rows] = records(body, DELIMITERS[options.delimiter], options.skipLines + 1).filter((record) => record.fields.length > 1 || record.fields[0]?.trim() !== "");
  if (header === undefined) {
    throw new NativeParseError("csv-table", options.skipLines + 1, "the file has no header row");
  }
  const names: string[] = [];
  for (const [position, cell] of header.fields.entries()) {
    // `id` is the row's id, so a header cell of that name that is not the id column is named by its position, as an unnamed one is, and is not shadowed by the row id.
    const named = columnName(cell, position + 1);
    const name = named === "id" && options.idColumn !== "id" ? `column_${String(position + 1)}` : named;
    const clash = names.indexOf(name);
    if (clash !== -1) {
      throw new NativeParseError("csv-table", header.line, `header cells ${String(clash + 1)} and ${String(position + 1)} both become the column ${name}`);
    }
    names.push(name);
  }
  const { idColumn, numericColumns } = options;
  for (const wanted of [...(idColumn === null ? [] : [idColumn]), ...numericColumns.map((entry) => entry.column)]) {
    if (!names.includes(wanted)) {
      throw new NativeParseError("csv-table", header.line, `the recipe names the column ${wanted}, which the header does not have`);
    }
  }
  const factors = new Map(numericColumns.map((entry) => [entry.column, entry.factor]));

  const nodes = rows.map((record, rowIndex): NativeRow => {
    if (record.fields.length !== names.length) {
      throw new NativeParseError("csv-table", record.line, `the row has ${String(record.fields.length)} fields, the header has ${String(names.length)}`);
    }
    const cells = new Map<string, string>(names.map((name, position) => [name, (record.fields[position] ?? "").trim()]));
    const id = idColumn === null ? String(rowIndex + 1) : (cells.get(idColumn) ?? "");
    if (id === "") {
      throw new NativeParseError("csv-table", record.line, `the id column ${idColumn ?? ""} is empty`);
    }
    const columns = names.filter((name) => name !== idColumn).map((name): [string, string | number | null] => {
      const cell = cells.get(name) ?? "";
      const factor = factors.get(name);

      return [name, factor === undefined ? (cell === "" ? null : cell) : numeric(cell, factor, name, record.line)];
    });

    return { ...Object.fromEntries(columns), id };
  });

  return { nodes };
}
