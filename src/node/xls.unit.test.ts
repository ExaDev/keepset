import { describe, expect, it } from "vitest";
import { ArchiveError } from "../errors";
import { bytesOf, cells, compoundFile, FORMULA_KIND, record, rk, workbookStream, xlsWorkbook } from "../test-support/biff";
import { sheetToCsv } from "../archive";

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const csv = (bytes: Uint8Array, sheet = "Data"): string => text(sheetToCsv(bytes, { kind: "xls", sheet }));

/** The rows that open WormAtlas's NeuronConnect.xls: its shared strings, and each row as its three text cells and its synapse count, which the file stores as RK numbers in a 1904 date system workbook. */
const NEURON_CONNECT = {
  strings: ["Neuron 1", "Neuron 2", "Type", "Nbr", "ADAR", "ADAL", "EJ", "ADFL", "AVDR"],
  rows: [
    { from: "ADAR", to: "ADAL", type: "EJ", count: 1 },
    { from: "ADFL", to: "ADAL", type: "EJ", count: 1 },
    { from: "AVDR", to: "ADAL", type: "EJ", count: 2 },
  ],
} as const;
/** The rows that open the Perm cash-collection sites workbook (rawdataclear.xls), whose coordinates are NUMBER records. */
const PERM_SITES = {
  header: ["LATITUDE", "LONGITUDE"],
  rows: [
    { latitude: 58.017_906_909_808_5, longitude: 56.239_907_937_124_4 },
    { latitude: 58.037_298_442_795_9, longitude: 56.315_785_534_679_9 },
  ],
} as const;
/** A sheet whose stream is past the mini stream cutoff, so it sits in regular sectors: each row is three NUMBER records. */
const LARGE = { rows: 80, columns: 3 } as const;
/** The XF index of each style the date tests define, and the number format each points at: the default, the built-in short date and a custom date and time. */
const STYLE = { general: 0, shortDate: 1, customDateTime: 2 } as const;
const FORMAT = { general: 0, shortDate: 14, customDateTime: 164 } as const;
const SERIAL = { day: 45_244, evening: 45_244.925_925_925_9, newYear2000In1904: 35_063 } as const;
const ERROR_NOT_AVAILABLE = 0x2a;
const FORMULA_RESULT = 2.25;
/** The high 32 bits of the double 1.5, which an RK value holds with its two flag bits clear. */
const RK_ONE_AND_A_HALF = 0x3f_f8_00_00;
const RK_VALUES = { negative: -7, hundredths: 1250, small: 5, whole: 3 } as const;
/** The SST content's offsets the CONTINUE test splits at: its counts take 8 bytes and each string's count and flags 3, so the first falls after "Cura" in the one-byte characters of the first string and the second after "Ωmeg" in the two-byte characters of the second. */
const SPLITS = { afterCura: 15, afterOmeg: 29 } as const;
const RECORD = { bof: 0x08_09, eof: 0x00_0a, filePass: 0x00_2f } as const;
const FILEPASS_BYTES = 4;
/** A BOF record's version and substream kind for an embedded chart, then the twelve bytes of build history the reader does not look at. */
const CHART_BOF = { version: 0x06_00, kind: 0x00_20, historyBytes: 12 } as const;

describe("sheetToCsv for an xls workbook", () => {
  it("reads WormAtlas's shared strings and RK counts as the CSV the xlsx reader would write", () => {
    const shared = (name: string): number => NEURON_CONNECT.strings.findIndex((candidate) => candidate === name);
    const header = ["Neuron 1", "Neuron 2", "Type", "Nbr"].map((name, column) => cells.labelSst({ row: 0, column }, shared(name)));
    const rows = NEURON_CONNECT.rows.flatMap(({ from, to, type, count }, index) => [
      cells.labelSst({ row: index + 1, column: 0 }, shared(from)),
      cells.labelSst({ row: index + 1, column: 1 }, shared(to)),
      cells.labelSst({ row: index + 1, column: 2 }, shared(type)),
      cells.rk({ row: index + 1, column: 3 }, rk.integer(count)),
    ]);
    expect(csv(xlsWorkbook({ "NeuronConnect.csv": [...header, ...rows] }, { strings: NEURON_CONNECT.strings, date1904: true }), "NeuronConnect.csv")).toBe("Neuron 1,Neuron 2,Type,Nbr\nADAR,ADAL,EJ,1\nADFL,ADAL,EJ,1\nAVDR,ADAL,EJ,2\n");
  });

  it("reads the Perm sites' NUMBER coordinates as the shortest decimal of each double", () => {
    const records = [cells.labelSst({ row: 0, column: 0 }, 0), cells.labelSst({ row: 0, column: 1 }, 1), ...PERM_SITES.rows.flatMap(({ latitude, longitude }, index) => [cells.number({ row: index + 1, column: 0 }, latitude), cells.number({ row: index + 1, column: 1 }, longitude)])];
    expect(csv(xlsWorkbook({ objects: records }, { strings: PERM_SITES.header }), "objects")).toBe("LATITUDE,LONGITUDE\n58.0179069098085,56.2399079371244\n58.0372984427959,56.3157855346799\n");
  });

  it("reads a workbook whose stream is in regular sectors as well as one in the mini stream", () => {
    const value = (row: number, column: number): number => row * LARGE.columns + column;
    const records = Array.from({ length: LARGE.rows }, (_unused, row) => Array.from({ length: LARGE.columns }, (_none, column) => cells.number({ row, column }, value(row, column)))).flat();
    const lines = csv(xlsWorkbook({ Data: records })).split("\n");
    expect(lines).toHaveLength(LARGE.rows + 1);
    expect(lines[LARGE.rows - 1]).toBe(Array.from({ length: LARGE.columns }, (_unused, column) => String(value(LARGE.rows - 1, column))).join(","));
    expect(csv(xlsWorkbook({ Data: [cells.number({ row: 0, column: 0 }, 1)] }))).toBe("1\n");
  });

  it("decodes RK and MULRK numbers: whole numbers, negative ones, hundredths and the high bits of a double", () => {
    const records = [
      cells.rk({ row: 0, column: 0 }, rk.integer(RK_VALUES.negative)),
      cells.rk({ row: 0, column: 1 }, rk.hundredths(RK_VALUES.hundredths)),
      cells.rk({ row: 0, column: 2 }, RK_ONE_AND_A_HALF),
      cells.mulRk(1, 0, [
        [0, rk.integer(RK_VALUES.whole)],
        [0, rk.hundredths(RK_VALUES.small)],
        [0, RK_ONE_AND_A_HALF],
      ]),
    ];
    expect(csv(xlsWorkbook({ Data: records }))).toBe("-7,12.5,1.5\n3,0.05,1.5\n");
  });

  it("joins a shared string split across CONTINUE records, reading each record's own flag byte", () => {
    const strings = ["Curaçao", "Ωmega", "plain"];
    const workbook = xlsWorkbook({ Data: strings.map((_text, column) => cells.labelSst({ row: 0, column }, column)) }, { strings, splits: [SPLITS.afterCura, SPLITS.afterOmeg] });
    expect(csv(workbook)).toBe("Curaçao,Ωmega,plain\n");
  });

  it("writes a date-styled number as ISO 8601 by the built-in and custom formats, in either date system", () => {
    const globals = { styles: [FORMAT.general, FORMAT.shortDate, FORMAT.customDateTime], formats: { [FORMAT.customDateTime]: "dd/mm/yyyy\\ hh:mm:ss" } };
    const records = [cells.number({ row: 0, column: 0, style: STYLE.shortDate }, SERIAL.day), cells.number({ row: 0, column: 1, style: STYLE.customDateTime }, SERIAL.evening), cells.rk({ row: 0, column: 2, style: STYLE.general }, rk.integer(SERIAL.day))];
    expect(csv(xlsWorkbook({ Data: records }, globals))).toBe("2023-11-14,2023-11-14T22:13:20,45244\n");
    expect(csv(xlsWorkbook({ Data: [cells.number({ row: 0, column: 0, style: STYLE.shortDate }, SERIAL.newYear2000In1904)] }, { ...globals, date1904: true }))).toBe("1999-12-31\n");
  });

  it("reads booleans, errors, LABEL text and formula results, the text result from the STRING record after its formula", () => {
    const records = [
      cells.boolErr({ row: 0, column: 0 }, 1, false),
      cells.boolErr({ row: 0, column: 1 }, ERROR_NOT_AVAILABLE, true),
      cells.label({ row: 0, column: 2 }, "inline, quoted"),
      cells.formulaNumber({ row: 1, column: 0 }, FORMULA_RESULT),
      cells.formulaOther({ row: 1, column: 1 }, FORMULA_KIND.string),
      cells.string("from a formula"),
      cells.formulaOther({ row: 1, column: 2 }, FORMULA_KIND.boolean, 0),
      cells.formulaOther({ row: 1, column: 3 }, FORMULA_KIND.error, ERROR_NOT_AVAILABLE),
      cells.formulaOther({ row: 1, column: 4 }, FORMULA_KIND.empty),
    ];
    expect(csv(xlsWorkbook({ Data: records }))).toBe('TRUE,#N/A,"inline, quoted",\n2.25,from a formula,FALSE,#N/A\n');
  });

  it("reads the sheet it is named in a workbook of several, ends at the last row holding a value and skips an embedded chart's records", () => {
    const chart = [record(RECORD.bof, bytesOf([2, CHART_BOF.version], [2, CHART_BOF.kind], new Uint8Array(CHART_BOF.historyBytes))), cells.number({ row: 5, column: 5 }, 1), record(RECORD.eof, new Uint8Array())];
    const workbook = xlsWorkbook({ Notes: [cells.label({ row: 0, column: 0 }, "explanation")], Data: [cells.label({ row: 2, column: 1 }, "values"), ...chart, cells.blank({ row: 7, column: 0 }), cells.blank({ row: 9, column: 3 })] });
    expect(csv(workbook, "Data")).toBe(",\n,\n,values\n");
    expect(csv(workbook, "Notes")).toBe("explanation\n");
    expect(() => csv(workbook, "Missing")).toThrow(/has no sheet Missing; it has Notes, Data/);
  });

  it("refuses bytes that are not a compound file, a BIFF5 workbook, an encrypted one and a shared string it lacks", () => {
    expect(() => csv(new Uint8Array(compoundFile("Workbook", new Uint8Array(1)).length))).toThrow(/not a compound file/);
    expect(() => csv(compoundFile("Book", workbookStream({ Data: [] })))).toThrow(/BIFF5 or earlier/);
    expect(() => csv(xlsWorkbook({ Data: [] }, { extra: [record(RECORD.filePass, new Uint8Array(FILEPASS_BYTES))] }))).toThrow(/encrypted/);
    expect(() => csv(xlsWorkbook({ Data: [cells.labelSst({ row: 0, column: 0 }, 1)] }, { strings: ["only"] }))).toThrow(ArchiveError);
  });
});
