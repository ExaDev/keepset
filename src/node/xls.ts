import { ArchiveError } from "../errors";
import { readRootStream } from "./cfb";
import { BUILT_IN_DATE_FORMATS, isDateFormat, isoOf, type SheetGrid } from "./sheet";

/** The BIFF record types this reader acts on ([MS-XLS] 2.3), by name. */
const RECORD = {
  bof: 0x08_09,
  eof: 0x00_0a,
  filePass: 0x00_2f,
  dateMode: 0x00_22,
  format: 0x04_1e,
  xf: 0x00_e0,
  boundSheet: 0x00_85,
  sst: 0x00_fc,
  continue: 0x00_3c,
  labelSst: 0x00_fd,
  label: 0x02_04,
  richString: 0x00_d6,
  number: 0x02_03,
  rk: 0x02_7e,
  mulRk: 0x00_bd,
  boolErr: 0x02_05,
  formula: 0x00_06,
  string: 0x02_07,
  array: 0x02_21,
  sharedFormula: 0x04_bc,
  table: 0x02_36,
} as const;
/** The records that may stand between a formula and the STRING record holding its text result: the array, shared formula or data table the formula belongs to ([MS-XLS] 2.1.7.20.6, the CELL rule). */
const FORMULA_COMPANIONS: ReadonlySet<number> = new Set([RECORD.array, RECORD.sharedFormula, RECORD.table]);
/** The BOF version of a BIFF8 stream, the format of Excel 97 to 2003; earlier BIFF versions store text in a code page and lay their records out differently. */
const BIFF8 = 0x06_00;
const RECORD_HEADER_BYTES = 4;
/** The widths of the unsigned integers a string's header holds. */
const U8 = 1;
const U16 = 2;
const U32 = 4;
/** The flag bits of a BIFF8 Unicode string ([MS-XLS] 2.5.293 and 2.5.294): two-byte characters, phonetic data after the runs, and formatting runs. */
const HIGH_BYTE = 0x01;
const EXTENDED = 0x04;
const RICH = 0x08;
const FORMATTING_RUN_BYTES = 4;
/** A FORMULA record's cached result is not a number when its last two bytes are all ones; its first byte then says what it is ([MS-XLS] 2.5.133). */
const NON_NUMERIC_RESULT = 0xff_ff;
const FORMULA_RESULT = { string: 0, boolean: 1, error: 2, empty: 3 } as const;
/** The error values a cell can hold, with the code BIFF stores for each ([MS-XLS] 2.5.97.2). */
const ERRORS = [
  { code: 0x00, text: "#NULL!" },
  { code: 0x07, text: "#DIV/0!" },
  { code: 0x0f, text: "#VALUE!" },
  { code: 0x17, text: "#REF!" },
  { code: 0x1d, text: "#NAME?" },
  { code: 0x24, text: "#NUM!" },
  { code: 0x2a, text: "#N/A" },
  { code: 0x2b, text: "#GETTING_DATA" },
] as const;
const HEXADECIMAL = 16;
/** The byte offsets of the fields this reader uses: a cell record's style after its row and column, the unique string count in the SST header, and the high half of a double, little-endian. */
const STYLE_OFFSET = 4;
const SST_UNIQUE_OFFSET = 4;
const DOUBLE_HIGH_HALF = 4;
/** An RK number's flags ([MS-XLS] 2.5.217): its value is a hundredth of what is stored, and what is stored is a signed integer rather than the high bits of a double. */
const RK_HUNDREDTHS = 0x01;
const RK_INTEGER = 0x02;
const HUNDRED = 100;
const RK_INTEGER_SHIFT = 2;
const RK_DOUBLE_MASK = 0xff_ff_ff_fc;
const MULRK_ENTRY_BYTES = 6;
/** A MULRK's row and first column before its values, and its last column after them. */
const MULRK_FIRST_ENTRY = 4;
const MULRK_FIXED_BYTES = 6;
/** A cell record's row, column and cell style, the first six bytes of every cell record. */
const CELL_HEADER_BYTES = 6;
const DOUBLE_BYTES = 8;
const FORMULA_SENTINEL_OFFSET = 6;
const BOOLERR_VALUE_OFFSET = 6;
const BOOLERR_KIND_OFFSET = 7;
const FORMULA_RESULT_VALUE_OFFSET = 2;
const SHEET_NAME_OFFSET = 6;
const SST_STRINGS_OFFSET = 8;

/** The records that hold a cell's value; a BLANK or MULBLANK holds only a style, so an empty cell, and is not among them. */
const CELL_RECORDS: ReadonlySet<number> = new Set([RECORD.labelSst, RECORD.label, RECORD.richString, RECORD.number, RECORD.rk, RECORD.mulRk, RECORD.boolErr, RECORD.formula]);

/**
 * A boolean cell's text.
 * @param value - The stored byte: zero for false.
 * @returns TRUE or FALSE, as the xlsx reader writes them.
 */
function booleanText(value: number): string {
  return value === 0 ? "FALSE" : "TRUE";
}

/**
 * An error cell's text.
 * @param code - The stored error code.
 * @param row - The 0-based row, for the error.
 * @returns The error as a spreadsheet shows it, such as `#N/A`.
 * @throws ArchiveError for a code BIFF does not define.
 */
function errorText(code: number, row: number): string {
  const text = ERRORS.find((error) => error.code === code)?.text;
  if (text === undefined) {
    throw new ArchiveError(`row ${String(row + 1)} holds the error code 0x${code.toString(HEXADECIMAL)}, which BIFF does not define`);
  }

  return text;
}

/** One record of a BIFF stream: its type and its body. */
interface BiffRecord {
  readonly type: number;
  readonly body: Uint8Array;
  readonly view: DataView;
}

/**
 * Splits a BIFF stream into records.
 * @param stream - The stream, or the part of it from a substream's BOF.
 * @returns The records, in order.
 * @throws ArchiveError when a record runs past the end of the stream.
 */
function* records(stream: Uint8Array): Generator<BiffRecord, void, undefined> {
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  for (let offset = 0; offset + RECORD_HEADER_BYTES <= stream.length; ) {
    const type = view.getUint16(offset, true);
    const length = view.getUint16(offset + 2, true);
    const start = offset + RECORD_HEADER_BYTES;
    if (start + length > stream.length) {
      throw new ArchiveError(`the workbook's record of type 0x${type.toString(HEXADECIMAL)} at byte ${String(offset)} runs past the end of its stream`);
    }
    const body = stream.subarray(start, start + length);
    yield { type, body, view: new DataView(body.buffer, body.byteOffset, body.byteLength) };
    offset = start + length;
  }
}

/** Reads the characters of BIFF8 strings across a record and the CONTINUE records after it: a string whose characters cross into a CONTINUE record starts that record with a fresh flag byte saying how wide the rest of its characters are, while the other parts of a string cross without one ([MS-XLS] 2.5.293). */
class StringReader {
  private part = 0;

  private offset: number;

  public constructor(
    private readonly parts: readonly Uint8Array[],
    start: number,
  ) {
    this.offset = start;
  }

  /** @returns The current part, moving to the next one when the current one is spent. */
  private current(): Uint8Array {
    let body = this.parts[this.part];
    while (body !== undefined && this.offset >= body.length) {
      this.part += 1;
      this.offset = 0;
      body = this.parts[this.part];
    }
    if (body === undefined) {
      throw new ArchiveError("a string of the workbook runs past the end of its records");
    }

    return body;
  }

  /**
   * Reads bytes that are not characters, which may cross from one part to the next.
   * @param count - How many.
   * @returns The bytes.
   */
  public bytes(count: number): Uint8Array {
    const out = new Uint8Array(count);
    for (let filled = 0; filled < count; ) {
      const body = this.current();
      const taken = Math.min(count - filled, body.length - this.offset);
      out.set(body.subarray(this.offset, this.offset + taken), filled);
      filled += taken;
      this.offset += taken;
    }

    return out;
  }

  /**
   * Reads a little-endian unsigned integer.
   * @param width - Its width in bytes.
   * @returns The integer.
   */
  public uint(width: typeof U8 | typeof U16 | typeof U32): number {
    const raw = this.bytes(width);
    const view = new DataView(raw.buffer);

    return width === U8 ? view.getUint8(0) : width === U16 ? view.getUint16(0, true) : view.getUint32(0, true);
  }

  /**
   * Reads characters, taking a fresh flag byte at the start of each later part they cross into.
   * @param count - How many characters.
   * @param high - Whether the characters start as two bytes each.
   * @returns The text.
   */
  public characters(count: number, high: boolean): string {
    let text = "";
    let wide = high;
    for (let left = count; left > 0; ) {
      let body = this.parts[this.part];
      if (body !== undefined && this.offset >= body.length) {
        this.part += 1;
        this.offset = 0;
        wide = (this.uint(U8) & HIGH_BYTE) !== 0;
      }
      body = this.current();
      const width = wide ? 2 : 1;
      const taken = Math.min(left, Math.floor((body.length - this.offset) / width));
      if (taken === 0) {
        throw new ArchiveError("a character of a workbook string is split across two records");
      }
      const run = body.subarray(this.offset, this.offset + taken * width);
      text += wide ? new TextDecoder("utf-16le").decode(run) : String.fromCharCode(...run);
      this.offset += taken * width;
      left -= taken;
    }

    return text;
  }

  /**
   * Reads one string: its character count (one or two bytes wide), its flags, the counts of any formatting runs and phonetic data, its characters, and then skips the runs and the phonetic data.
   * @param countWidth - The width of its character count.
   * @returns The text.
   */
  public string(countWidth: typeof U8 | typeof U16): string {
    this.current();
    const count = this.uint(countWidth);
    const flags = this.uint(U8);
    const runs = (flags & RICH) === 0 ? 0 : this.uint(U16);
    const extended = (flags & EXTENDED) === 0 ? 0 : this.uint(U32);
    const text = this.characters(count, (flags & HIGH_BYTE) !== 0);
    this.bytes(runs * FORMATTING_RUN_BYTES + extended);

    return text;
  }
}

/** What the workbook globals say that the cells need: the strings of the shared string table, which cell styles show dates, the date system, and where each sheet's records start. */
interface Globals {
  readonly strings: readonly string[];
  readonly dateStyles: ReadonlySet<number>;
  readonly date1904: boolean;
  readonly sheets: ReadonlyMap<string, number>;
}

/**
 * Reads the workbook globals substream, up to its EOF.
 * @param stream - The Workbook stream.
 * @returns The globals.
 * @throws ArchiveError when the stream is not BIFF8, is encrypted or its shared string table is malformed.
 */
function readGlobals(stream: Uint8Array): Globals {
  const iterator = records(stream);
  const first = iterator.next();
  if (first.done === true || first.value.type !== RECORD.bof || first.value.body.length < 2) {
    throw new ArchiveError("the workbook stream does not open with a BOF record");
  }
  const version = first.value.view.getUint16(0, true);
  if (version !== BIFF8) {
    throw new ArchiveError(`the workbook is BIFF version 0x${version.toString(HEXADECIMAL)}; only BIFF8 (Excel 97 to 2003) is read`);
  }
  const formats = new Map<number, string>();
  const styleFormats: number[] = [];
  const sheets = new Map<string, number>();
  let strings: string[] = [];
  let date1904 = false;
  let sst: Uint8Array[] | undefined;
  const finishSst = (): void => {
    if (sst === undefined) {
      return;
    }
    const [head] = sst;
    if (head === undefined || head.length < SST_STRINGS_OFFSET) {
      throw new ArchiveError("the workbook's shared string table is shorter than its header");
    }
    const unique = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(SST_UNIQUE_OFFSET, true);
    const reader = new StringReader(sst, SST_STRINGS_OFFSET);
    strings = Array.from({ length: unique }, () => reader.string(U16));
    sst = undefined;
  };
  for (const record of iterator) {
    if (record.type !== RECORD.continue) {
      finishSst();
    }
    if (record.type === RECORD.eof) {
      break;
    }
    if (record.type === RECORD.filePass) {
      throw new ArchiveError("the workbook is encrypted");
    }
    if (record.type === RECORD.dateMode) {
      date1904 = record.view.getUint16(0, true) === 1;
    } else if (record.type === RECORD.format) {
      formats.set(record.view.getUint16(0, true), new StringReader([record.body], 2).string(U16));
    } else if (record.type === RECORD.xf) {
      styleFormats.push(record.view.getUint16(2, true));
    } else if (record.type === RECORD.boundSheet) {
      sheets.set(new StringReader([record.body], SHEET_NAME_OFFSET).string(U8), record.view.getUint32(0, true));
    } else if (record.type === RECORD.sst) {
      sst = [record.body];
    } else if (record.type === RECORD.continue && sst !== undefined) {
      sst.push(record.body);
    }
  }
  finishSst();
  const dateStyles = new Set<number>();
  for (const [index, id] of styleFormats.entries()) {
    const code = formats.get(id);
    if (code === undefined ? BUILT_IN_DATE_FORMATS.some((range) => id >= range.first && id <= range.last) : isDateFormat(code)) {
      dateStyles.add(index);
    }
  }

  return { strings, dateStyles, date1904, sheets };
}

/**
 * Decodes an RK number ([MS-XLS] 2.5.217): a signed 30-bit integer or the high 30 bits of a double, either of them possibly a hundredth of the value.
 * @param rk - The stored 32 bits.
 * @returns The number.
 */
function rkValue(rk: number): number {
  let value: number;
  if ((rk & RK_INTEGER) === 0) {
    const bits = new DataView(new ArrayBuffer(DOUBLE_BYTES));
    bits.setUint32(DOUBLE_HIGH_HALF, (rk & RK_DOUBLE_MASK) >>> 0, true);
    value = bits.getFloat64(0, true);
  } else {
    value = rk >> RK_INTEGER_SHIFT;
  }

  return (rk & RK_HUNDREDTHS) === 0 ? value : value / HUNDRED;
}

/**
 * Reads one sheet of a legacy binary Excel workbook (`.xls`, BIFF8 in a compound file) as the same text the xlsx reader gives: a date cell as ISO 8601 text (recognised by its cell style's number format, in either date system), a boolean as TRUE or FALSE, an error as its text, a number as the shortest decimal that is the stored double, and a formula as its cached result.
 * @param bytes - The workbook.
 * @param sheet - The sheet's name.
 * @returns The sheet's cells.
 * @throws ArchiveError when the bytes are not a BIFF8 workbook, it is encrypted, the sheet is missing, or a record is malformed.
 */
export function xlsGrid(bytes: Uint8Array, sheet: string): SheetGrid {
  const stream = readRootStream(bytes, "Workbook");
  if (stream === undefined) {
    throw new ArchiveError(readRootStream(bytes, "Book") === undefined ? "the compound file holds no Workbook stream, so it is not an Excel workbook" : "the workbook is BIFF5 or earlier (Excel 95), which stores text in a code page; only BIFF8 (Excel 97 to 2003) is read");
  }
  const globals = readGlobals(stream);
  const start = globals.sheets.get(sheet);
  if (start === undefined) {
    throw new ArchiveError(`the workbook has no sheet ${sheet}; it has ${[...globals.sheets.keys()].join(", ")}`);
  }
  if (start >= stream.length) {
    throw new ArchiveError(`the workbook places the sheet ${sheet} at byte ${String(start)}, past the end of its stream`);
  }

  const rows = new Map<number, (string | undefined)[]>();
  let width = 0;
  const put = (row: number, column: number, text: string): void => {
    if (text === "") {
      return;
    }
    const cells = rows.get(row + 1) ?? [];
    cells[column] = text;
    rows.set(row + 1, cells);
    width = Math.max(width, column + 1);
  };
  const numberText = (value: number, style: number, row: number): string => {
    if (!globals.dateStyles.has(style)) {
      return String(value);
    }
    if (!Number.isFinite(value) || value < 0) {
      throw new ArchiveError(`row ${String(row + 1)} has a date cell holding ${String(value)}`);
    }

    return isoOf(value, globals.date1904);
  };
  let depth = 0;
  let pendingString: { readonly row: number; readonly column: number; readonly parts: Uint8Array[] } | undefined;
  const finishString = (): void => {
    if (pendingString !== undefined) {
      put(pendingString.row, pendingString.column, new StringReader(pendingString.parts, 0).string(U16));
      pendingString = undefined;
    }
  };
  for (const record of records(stream.subarray(start))) {
    if (pendingString !== undefined) {
      if (pendingString.parts.length === 0) {
        if (FORMULA_COMPANIONS.has(record.type)) {
          continue;
        }
        if (record.type !== RECORD.string) {
          throw new ArchiveError(`row ${String(pendingString.row + 1)} has a formula with a text result but no STRING record after it`);
        }
        pendingString.parts.push(record.body);
        continue;
      }
      if (record.type === RECORD.continue) {
        pendingString.parts.push(record.body);
        continue;
      }
      finishString();
    }
    if (record.type === RECORD.bof) {
      depth += 1;
      continue;
    }
    if (record.type === RECORD.eof) {
      depth -= 1;
      if (depth === 0) {
        break;
      }
      continue;
    }
    if (record.type === RECORD.string && depth === 1) {
      throw new ArchiveError("the sheet has a STRING record that follows no formula");
    }
    // An embedded chart is a substream of its own inside the sheet's, and its records are not the sheet's cells.
    if (depth !== 1 || !CELL_RECORDS.has(record.type)) {
      continue;
    }
    if (record.body.length < CELL_HEADER_BYTES) {
      throw new ArchiveError(`the sheet has a cell record of type 0x${record.type.toString(HEXADECIMAL)} shorter than a cell's row, column and style`);
    }
    const row = record.view.getUint16(0, true);
    const column = record.view.getUint16(2, true);
    const style = record.view.getUint16(STYLE_OFFSET, true);
    if (record.type === RECORD.labelSst) {
      const index = record.view.getUint32(CELL_HEADER_BYTES, true);
      const text = globals.strings[index];
      if (text === undefined) {
        throw new ArchiveError(`row ${String(row + 1)} names the shared string ${String(index)}, which the workbook does not have`);
      }
      put(row, column, text);
    } else if (record.type === RECORD.label || record.type === RECORD.richString) {
      put(row, column, new StringReader([record.body], CELL_HEADER_BYTES).string(U16));
    } else if (record.type === RECORD.number) {
      put(row, column, numberText(record.view.getFloat64(CELL_HEADER_BYTES, true), style, row));
    } else if (record.type === RECORD.rk) {
      put(row, column, numberText(rkValue(record.view.getUint32(CELL_HEADER_BYTES, true)), style, row));
    } else if (record.type === RECORD.mulRk) {
      // A MULRK holds the row and the first column, then a style and an RK value for each column, then the last column.
      const count = (record.body.length - MULRK_FIXED_BYTES) / MULRK_ENTRY_BYTES;
      if (!Number.isInteger(count)) {
        throw new ArchiveError(`row ${String(row + 1)} has a MULRK record whose length is not a whole number of values`);
      }
      for (let index = 0; index < count; index += 1) {
        const offset = MULRK_FIRST_ENTRY + index * MULRK_ENTRY_BYTES;
        put(row, column + index, numberText(rkValue(record.view.getUint32(offset + 2, true)), record.view.getUint16(offset, true), row));
      }
    } else if (record.type === RECORD.boolErr) {
      const value = record.view.getUint8(BOOLERR_VALUE_OFFSET);
      put(row, column, record.view.getUint8(BOOLERR_KIND_OFFSET) === 0 ? booleanText(value) : errorText(value, row));
    } else if (record.view.getUint16(CELL_HEADER_BYTES + FORMULA_SENTINEL_OFFSET, true) === NON_NUMERIC_RESULT) {
      const kind = record.view.getUint8(CELL_HEADER_BYTES);
      const value = record.view.getUint8(CELL_HEADER_BYTES + FORMULA_RESULT_VALUE_OFFSET);
      if (kind === FORMULA_RESULT.string) {
        // The text of a formula's string result is the STRING record that follows it.
        pendingString = { row, column, parts: [] };
      } else if (kind === FORMULA_RESULT.boolean) {
        put(row, column, booleanText(value));
      } else if (kind === FORMULA_RESULT.error) {
        put(row, column, errorText(value, row));
      } else if (kind !== FORMULA_RESULT.empty) {
        throw new ArchiveError(`row ${String(row + 1)} has a formula whose cached result is of unknown kind ${String(kind)}`);
      }
    } else {
      put(row, column, numberText(record.view.getFloat64(CELL_HEADER_BYTES, true), style, row));
    }
  }
  finishString();

  return { rows, width };
}
