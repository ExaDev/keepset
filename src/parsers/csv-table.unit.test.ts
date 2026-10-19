import { describe, expect, it } from "vitest";
import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import { columnName } from "./csv-table";
import { parseNative } from "./parse-native";

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** The byte order mark some exporters put before the first header, written as an escape because the character is invisible. */
const BYTE_ORDER_MARK = "\uFEFF";

/** One byte per character, for files whose bytes are not utf-8: each character's code point below 256 is the byte. */
const bytesOf = (text: string): Uint8Array => Uint8Array.from(text, (char) => char.charCodeAt(0));

/** The 1-based lines the tests below expect an error on: the second data row of a three-line file, and the row after a quoted field that spans two lines. */
const THIRD_LINE = 3;
const FOURTH_LINE = 4;

const table = (options: Partial<Extract<Parser, { format: "csv-table" }>> = {}): Parser => ({
  format: "csv-table",
  encoding: "utf-8",
  delimiter: "comma",
  skipLines: 0,
  idColumn: null,
  numericColumns: [],
  ...options,
});

function parseError(run: () => unknown): NativeParseError {
  try {
    run();
  } catch (error) {
    if (error instanceof NativeParseError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a NativeParseError");
}

describe("the csv-table parser", () => {
  it("reads a header and rows, numbering the rows when the recipe names no id column", () => {
    expect(parseNative(utf8("name,status\nA,open\nB,closed\n"), table())).toEqual({
      nodes: [
        { id: "1", name: "A", status: "open" },
        { id: "2", name: "B", status: "closed" },
      ],
    });
  });

  it("takes the id from the recipe's id column, which is then not also a column", () => {
    expect(parseNative(utf8("case,status\nx-1,open\n"), table({ idColumn: "case" })).nodes).toEqual([{ id: "x-1", status: "open" }]);
  });

  it("makes an empty cell null in every row, so every row carries every column", () => {
    expect(parseNative(utf8("a,b,c\n1,,3\n,,\n"), table()).nodes).toEqual([
      { id: "1", a: "1", b: null, c: "3" },
      { id: "2", a: null, b: null, c: null },
    ]);
  });

  it("reads quoted fields holding the delimiter, line breaks and doubled quotes", () => {
    const text = 'name,note\n"Smith, J.","said ""hi""\nthen left"\nplain,x\n';
    expect(parseNative(utf8(text), table()).nodes).toEqual([
      { id: "1", name: "Smith, J.", note: 'said "hi"\nthen left' },
      { id: "2", name: "plain", note: "x" },
    ]);
  });

  it("accepts LF, CRLF and CR line endings, a byte order mark and a missing final newline", () => {
    for (const ending of ["\n", "\r\n", "\r"]) {
      expect(parseNative(utf8(`${BYTE_ORDER_MARK}a,b${ending}1,2${ending}3,4`), table()).nodes).toEqual([
        { id: "1", a: "1", b: "2" },
        { id: "2", a: "3", b: "4" },
      ]);
    }
  });

  it("reads tab and semicolon delimited files, skipping the lines the recipe says come before the header", () => {
    expect(parseNative(utf8("title line\nnote\na\tb\n1\t2\n"), table({ delimiter: "tab", skipLines: 2 })).nodes).toEqual([{ id: "1", a: "1", b: "2" }]);
    expect(parseNative(utf8("a;b\n1,5;2\n"), table({ delimiter: "semicolon" })).nodes).toEqual([{ id: "1", a: "1,5", b: "2" }]);
  });

  it("skips blank lines and trims cells", () => {
    expect(parseNative(utf8("a,b\n\n  x , y \n\n"), table()).nodes).toEqual([{ id: "1", a: "x", b: "y" }]);
  });

  it("reads a declared numeric column as a decimal number times its factor, null when empty", () => {
    const parser = table({ numericColumns: [{ column: "minutes", factor: 60 }, { column: "prize", factor: 1 }] });
    expect(parseNative(utf8("minutes,prize,label\n2,1.5,x\n,-3e2,y\n0.5,.25,z\n"), parser).nodes).toEqual([
      { id: "1", minutes: 120, prize: 1.5, label: "x" },
      { id: "2", minutes: null, prize: -300, label: "y" },
      { id: "3", minutes: 30, prize: 0.25, label: "z" },
    ]);
  });

  it("refuses a numeric cell that is not a decimal number, naming the line and column", () => {
    const parser = table({ numericColumns: [{ column: "n", factor: 1 }] });
    for (const bad of ['"1,234"', "0x10", "Infinity", "NaN", "12abc", "--1"]) {
      const error = parseError(() => parseNative(utf8(`n\n1\n${bad}\n`), parser));
      expect(error.line).toBe(THIRD_LINE);
      expect(error.message).toMatch(/column n is declared numeric/);
    }
  });

  it("names columns by their header with other characters replaced by one underscore", () => {
    expect(columnName("Date received", 1)).toBe("Date_received");
    expect(columnName("Timely response?", 1)).toBe("Timely_response");
    expect(columnName("  Zip / Postal  code ", 1)).toBe("Zip_Postal_code");
    expect(columnName("2024 total", 1)).toBe("c_2024_total");
    expect(columnName("G6A_G6_COMPL_DD", 1)).toBe("G6A_G6_COMPL_DD");
    expect(columnName("???", THIRD_LINE)).toBe("column_3");
    expect(columnName("", 1)).toBe("column_1");
    expect(parseNative(utf8("Date received,Timely response?\nx,y\n"), table()).nodes).toEqual([{ id: "1", Date_received: "x", Timely_response: "y" }]);
  });

  it("names a header cell with nothing left by its position, so an unnamed index column is a column", () => {
    expect(parseNative(utf8(",a,???\n0,x,y\n"), table()).nodes).toEqual([{ id: "1", column_1: "0", a: "x", column_3: "y" }]);
  });

  it("refuses a header that repeats a name", () => {
    expect(parseError(() => parseNative(utf8("a b,a_b\n1,2\n"), table())).message).toMatch(/both become the column a_b/);
    expect(parseError(() => parseNative(utf8("column_2,\n1,2\n"), table())).message).toMatch(/both become the column column_2/);
  });

  it("reserves id for the row's id: a column of that name is the id column or is named by its position", () => {
    expect(parseNative(utf8("id,x\n7,2\n"), table({ idColumn: "id" })).nodes).toEqual([{ id: "7", x: "2" }]);
    expect(parseNative(utf8("id,x\n7,2\n"), table()).nodes).toEqual([{ id: "1", column_1: "7", x: "2" }]);
    expect(parseNative(utf8("case,id\nc1,7\n"), table({ idColumn: "case" })).nodes).toEqual([{ id: "c1", column_2: "7" }]);
  });

  it("refuses a recipe that names a column the header lacks, and an empty id", () => {
    expect(parseError(() => parseNative(utf8("a\n1\n"), table({ idColumn: "missing" }))).message).toMatch(/names the column missing/);
    expect(parseError(() => parseNative(utf8("a\n1\n"), table({ numericColumns: [{ column: "missing", factor: 1 }] }))).message).toMatch(/names the column missing/);
    const error = parseError(() => parseNative(utf8("k,v\nx,1\n ,2\n"), table({ idColumn: "k" })));
    expect(error.line).toBe(THIRD_LINE);
  });

  it("refuses a row with a different number of fields than the header, naming its line", () => {
    const error = parseError(() => parseNative(utf8("a,b\n1,2\n3\n"), table()));
    expect(error.line).toBe(THIRD_LINE);
    expect(error.message).toMatch(/1 fields, the header has 2/);
  });

  it("counts the lines of quoted line breaks, so an error names the line an editor shows", () => {
    const error = parseError(() => parseNative(utf8('a,b\n"x\ny",2\n3\n'), table()));
    expect(error.line).toBe(FOURTH_LINE);
  });

  it("refuses an unclosed quote, a quote inside an unquoted field, an empty file and a file shorter than its skipped lines", () => {
    expect(parseError(() => parseNative(utf8('a\n"open\n'), table())).message).toMatch(/never closed/);
    expect(parseError(() => parseNative(utf8('a\nx"y\n'), table())).message).toMatch(/quote opens inside an unquoted field/);
    expect(parseError(() => parseNative(utf8("\n\n"), table())).message).toMatch(/no header row/);
    expect(parseError(() => parseNative(utf8("a\n"), table({ skipLines: THIRD_LINE }))).message).toMatch(/fewer than 3 lines/);
  });

  it("keeps a column named like an inherited property as a column of its own", () => {
    const [row] = parseNative(utf8("constructor,toString\n1,2\n"), table()).nodes;
    expect(Object.keys(row ?? {}).sort()).toEqual(["constructor", "id", "toString"]);
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
  });

  it("decodes a latin1 file in the recipe's encoding, and refuses invalid utf-8", () => {
    const file = bytesOf("n\n\u00e9");
    expect(parseNative(file, table({ encoding: "latin1" })).nodes).toEqual([{ id: "1", n: "\u00e9" }]);
    expect(parseError(() => parseNative(file, table())).message).toMatch(/not valid utf-8/);
  });
});
