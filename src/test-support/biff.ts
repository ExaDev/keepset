/** Writers for the legacy binary Excel format the xls reader's tests build workbooks with: BIFF8 records, a Workbook stream that lays out the globals and sheets with the offsets the sheet records need, and the compound file that holds it. */

/** Field widths in bytes: unsigned integers of one, two and four bytes, and a double. */
const U8 = 1;
const U16 = 2;
const U32 = 4;
const F64 = 8;
type Width = typeof U8 | typeof U16 | typeof U32 | typeof F64;

const SECTOR_BYTES = 512;
const MINI_SECTOR_BYTES = 64;
const MINI_STREAM_CUTOFF = 4096;
const ENTRIES_PER_SECTOR = SECTOR_BYTES / U32;
const HEADER_DIFAT_ENTRIES = 109;
const DIRECTORY_ENTRY_BYTES = 128;
/** The directory slots a 512-byte sector holds; the writer fills the first two (the root and the stream) and leaves the rest unused. */
const DIRECTORY_SLOTS = SECTOR_BYTES / DIRECTORY_ENTRY_BYTES;
const SECTOR = { endOfChain: 0xff_ff_ff_fe, free: 0xff_ff_ff_ff, fat: 0xff_ff_ff_fd, noStream: 0xff_ff_ff_ff } as const;
/** The compound file header fields the writer sets, by byte offset, and the values of the fixed ones ([MS-CFB] 2.2). */
const HEADER = { minorVersion: 0x18, majorVersion: 0x1a, byteOrder: 0x1c, sectorShift: 0x1e, miniSectorShift: 0x20, fatSectors: 0x2c, firstDirectorySector: 0x30, miniStreamCutoff: 0x38, firstMiniFatSector: 0x3c, miniFatSectors: 0x40, firstDifatSector: 0x44, difatSectors: 0x48, difat: 0x4c } as const;
const HEADER_VALUES = { minorVersion: 0x3e, majorVersion: 3, byteOrder: 0xff_fe, sectorShift: 9, miniSectorShift: 6 } as const;
/** The signature a compound file opens with, as the little-endian 64-bit number of its bytes D0 CF 11 E0 A1 B1 1A E1. */
const SIGNATURE = 0xe1_1a_b1_a1_e0_11_cf_d0n;
/** The directory entry fields the writer sets, by byte offset within the entry ([MS-CFB] 2.6.1). */
const ENTRY = { nameLength: 0x40, type: 0x42, colour: 0x43, left: 0x44, right: 0x48, child: 0x4c, start: 0x74, size: 0x78 } as const;
const OBJECT = { stream: 2, root: 5 } as const;
const BLACK = 1;
/** The BIFF record types the writer emits ([MS-XLS] 2.3). */
const TYPE = { bof: 0x08_09, eof: 0x00_0a, dateMode: 0x00_22, format: 0x04_1e, xf: 0x00_e0, boundSheet: 0x00_85, sst: 0x00_fc, continue: 0x00_3c, labelSst: 0x00_fd, label: 0x02_04, number: 0x02_03, rk: 0x02_7e, mulRk: 0x00_bd, boolErr: 0x02_05, blank: 0x02_01, formula: 0x00_06, string: 0x02_07 } as const;
const BOF = { biff8: 0x06_00, globals: 0x00_05, worksheet: 0x00_10 } as const;
/** The bytes of an XF record after its font and number format ids, which the reader does not look at. */
const XF_REST_BYTES = 16;
/** The last two bytes of a FORMULA record's cached result when it is not a number. */
const NON_NUMERIC_RESULT = 0xff_ff;
const RK_FLAGS = { integer: 0x02, hundredths: 0x03 } as const;
const RK_SHIFT = 2;
const LATIN1_LIMIT = 0xff;
/** A record's type and length, before its body. */
const RECORD_HEADER_BYTES = U16 + U16;

/** A BIFF record: its type and body. */
export interface BiffRecord {
  readonly type: number;
  readonly body: Uint8Array;
}

/** A field to write: its width and value, or bytes taken as they are. */
type Field = readonly [Width, number] | Uint8Array;

/**
 * Writes little-endian fields into a new byte array.
 * @param fields - The fields, in order.
 * @returns The bytes.
 */
export function bytesOf(...fields: readonly Field[]): Uint8Array {
  const length = fields.reduce((total, field) => total + (field instanceof Uint8Array ? field.length : field[0]), 0);
  const out = new Uint8Array(length);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const field of fields) {
    if (field instanceof Uint8Array) {
      out.set(field, offset);
      offset += field.length;
      continue;
    }
    const [width, value] = field;
    if (width === U8) {
      view.setUint8(offset, value);
    } else if (width === U16) {
      view.setUint16(offset, value, true);
    } else if (width === U32) {
      view.setUint32(offset, value >>> 0, true);
    } else {
      view.setFloat64(offset, value, true);
    }
    offset += width;
  }

  return out;
}

/**
 * The characters of a BIFF8 string: one byte each when every UTF-16 code unit fits in one, two bytes each otherwise.
 * @param text - The text.
 * @returns Whether the characters are two bytes wide, and their bytes.
 */
export function characters(text: string): { readonly wide: boolean; readonly bytes: Uint8Array } {
  const units = Array.from({ length: text.length }, (_unused, index) => text.charCodeAt(index));
  const wide = units.some((unit) => unit > LATIN1_LIMIT);

  return { wide, bytes: wide ? bytesOf(...units.map((unit): Field => [U16, unit])) : Uint8Array.from(units) };
}

/**
 * A BIFF8 Unicode string: its character count, its flags, then its characters.
 * @param text - The text.
 * @param countWidth - The width of the count: one byte for a sheet name, two elsewhere.
 * @returns The bytes.
 */
export function unicodeString(text: string, countWidth: typeof U8 | typeof U16 = U16): Uint8Array {
  const chars = characters(text);

  return bytesOf([countWidth, text.length], [U8, chars.wide ? 1 : 0], chars.bytes);
}

/**
 * A record.
 * @param type - Its type.
 * @param body - Its body.
 * @returns The record.
 */
export function record(type: number, body: Uint8Array): BiffRecord {
  return { type, body };
}

/** Where a cell sits, by 0-based row and column, and the XF index that styles it. */
export interface Place {
  readonly row: number;
  readonly column: number;
  readonly style?: number;
}

/**
 * A cell record's row, column and style.
 * @param place - The cell's place.
 * @returns The fields.
 */
function at(place: Place): Field[] {
  return [
    [U16, place.row],
    [U16, place.column],
    [U16, place.style ?? 0],
  ];
}

/** What a formula's cached result is when it is not a number: text (in the STRING record after it), a boolean, an error, or the empty string. */
export const FORMULA_KIND = { string: 0, boolean: 1, error: 2, empty: 3 } as const;

/** Cell records. */
export const cells = {
  labelSst: (place: Place, index: number): BiffRecord => record(TYPE.labelSst, bytesOf(...at(place), [U32, index])),
  label: (place: Place, text: string): BiffRecord => record(TYPE.label, bytesOf(...at(place), unicodeString(text))),
  number: (place: Place, value: number): BiffRecord => record(TYPE.number, bytesOf(...at(place), [F64, value])),
  rk: (place: Place, value: number): BiffRecord => record(TYPE.rk, bytesOf(...at(place), [U32, value])),
  /** A MULRK: a run of RK values along a row from `first`, each with its own style. */
  mulRk: (row: number, first: number, values: readonly (readonly [style: number, value: number])[]): BiffRecord => record(TYPE.mulRk, bytesOf([U16, row], [U16, first], ...values.flatMap(([style, value]): Field[] => [[U16, style], [U32, value]]), [U16, first + values.length - 1])),
  boolErr: (place: Place, value: number, error: boolean): BiffRecord => record(TYPE.boolErr, bytesOf(...at(place), [U8, value], [U8, error ? 1 : 0])),
  blank: (place: Place): BiffRecord => record(TYPE.blank, bytesOf(...at(place))),
  /** A formula with a cached number; the formula's own flags, chain and parsed tokens are zero. */
  formulaNumber: (place: Place, value: number): BiffRecord => record(TYPE.formula, bytesOf(...at(place), [F64, value], [U16, 0], [U32, 0], [U16, 0])),
  /** A formula whose cached result is not a number, of a `FORMULA_KIND`. */
  formulaOther: (place: Place, kind: number, value = 0): BiffRecord => record(TYPE.formula, bytesOf(...at(place), [U8, kind], [U8, 0], [U8, value], [U8, 0], [U16, 0], [U16, NON_NUMERIC_RESULT], [U16, 0], [U32, 0], [U16, 0])),
  string: (text: string): BiffRecord => record(TYPE.string, unicodeString(text)),
} as const;

/** RK encodings: a whole number, and a whole number of hundredths. */
export const rk = {
  integer: (value: number): number => ((value << RK_SHIFT) | RK_FLAGS.integer) >>> 0,
  hundredths: (value: number): number => ((value << RK_SHIFT) | RK_FLAGS.hundredths) >>> 0,
} as const;

/** What the globals substream holds beyond the sheets: custom number formats by id, each XF's number format id in XF order, the date system, the shared strings (split into CONTINUE records where `splits` says) and records added as they are. */
export interface Globals {
  readonly formats?: Readonly<Record<number, string>>;
  readonly styles?: readonly number[];
  readonly date1904?: boolean;
  readonly strings?: readonly string[];
  /** Byte offsets into the SST content (its two counts first) at which a CONTINUE record starts; one that falls among a string's characters, its first included, opens the record with the characters' flag byte, as BIFF8 does. */
  readonly splits?: readonly number[];
  readonly extra?: readonly BiffRecord[];
}

/**
 * The shared string table, split into SST and CONTINUE records at the given offsets.
 * @param strings - The strings.
 * @param splits - Offsets into the table's content where a new record starts.
 * @returns The records.
 */
function sharedStringTable(strings: readonly string[], splits: readonly number[]): BiffRecord[] {
  const pieces: { readonly bytes: Uint8Array; readonly wide?: boolean }[] = [{ bytes: bytesOf([U32, strings.length], [U32, strings.length]) }];
  for (const text of strings) {
    const chars = characters(text);
    pieces.push({ bytes: bytesOf([U16, text.length], [U8, chars.wide ? 1 : 0]) }, { bytes: chars.bytes, wide: chars.wide });
  }
  const bodies: number[][] = [[]];
  const pending = new Set(splits);
  let position = 0;
  for (const piece of pieces) {
    for (const byte of piece.bytes) {
      if (pending.has(position)) {
        bodies.push(piece.wide === undefined ? [] : [piece.wide ? 1 : 0]);
      }
      bodies.at(-1)?.push(byte);
      position += 1;
    }
  }

  return bodies.map((body, index) => record(index === 0 ? TYPE.sst : TYPE.continue, Uint8Array.from(body)));
}

/**
 * Writes a Workbook stream: the globals (BOF, date mode, formats, styles, sheet entries, shared strings, EOF) and then each sheet's substream (BOF, its records, EOF), with each sheet entry holding its substream's offset.
 * @param sheets - Each sheet's records, by name.
 * @param globals - What else the globals hold.
 * @returns The stream.
 */
export function workbookStream(sheets: Readonly<Record<string, readonly BiffRecord[]>>, globals: Readonly<Globals> = {}): Uint8Array {
  const bof = (kind: number): BiffRecord => record(TYPE.bof, bytesOf([U16, BOF.biff8], [U16, kind], [U16, 0], [U16, 0], [U32, 0], [U32, 0]));
  const eof = record(TYPE.eof, new Uint8Array());
  const names = Object.keys(sheets);
  const before: BiffRecord[] = [
    bof(BOF.globals),
    record(TYPE.dateMode, bytesOf([U16, globals.date1904 === true ? 1 : 0])),
    ...Object.entries(globals.formats ?? {}).map(([id, code]) => record(TYPE.format, bytesOf([U16, Number(id)], unicodeString(code)))),
    ...(globals.styles ?? [0]).map((format) => record(TYPE.xf, bytesOf([U16, 0], [U16, format], new Uint8Array(XF_REST_BYTES)))),
    ...(globals.extra ?? []),
  ];
  const after: BiffRecord[] = [...(globals.strings === undefined ? [] : sharedStringTable(globals.strings, globals.splits ?? [])), eof];
  const size = (records: readonly BiffRecord[]): number => records.reduce((total, item) => total + RECORD_HEADER_BYTES + item.body.length, 0);
  const sheetEntry = (name: string, offset: number): BiffRecord => record(TYPE.boundSheet, bytesOf([U32, offset], [U8, 0], [U8, 0], unicodeString(name, U8)));
  let offset = size(before) + size(names.map((name) => sheetEntry(name, 0))) + size(after);
  const substreams: BiffRecord[] = [];
  const entries: BiffRecord[] = [];
  for (const name of names) {
    entries.push(sheetEntry(name, offset));
    const substream = [bof(BOF.worksheet), ...(sheets[name] ?? []), eof];
    substreams.push(...substream);
    offset += size(substream);
  }

  return bytesOf(...[...before, ...entries, ...after, ...substreams].flatMap((item): Field[] => [[U16, item.type], [U16, item.body.length], item.body]));
}

/**
 * Writes a version 3 compound file (512-byte sectors) holding one stream at its root: in regular sectors when the stream reaches the mini stream cutoff, otherwise in the mini stream, as the format requires.
 * @param name - The stream's name, such as `Workbook`.
 * @param stream - The stream's bytes.
 * @returns The file.
 */
export function compoundFile(name: string, stream: Uint8Array): Uint8Array {
  const mini = stream.length < MINI_STREAM_CUTOFF;
  const miniStreamBytes = Math.ceil(stream.length / MINI_SECTOR_BYTES) * MINI_SECTOR_BYTES;
  const dataSectors = Math.ceil((mini ? miniStreamBytes : stream.length) / SECTOR_BYTES);
  const miniFatSectors = mini ? 1 : 0;
  let fatSectors = 1;
  while (fatSectors * ENTRIES_PER_SECTOR < fatSectors + 1 + miniFatSectors + dataSectors) {
    fatSectors += 1;
  }
  if (fatSectors > HEADER_DIFAT_ENTRIES) {
    throw new Error("the test writer holds its file allocation table only in the header's DIFAT");
  }
  const directorySector = fatSectors;
  const miniFatSector = directorySector + 1;
  const firstData = directorySector + 1 + miniFatSectors;
  const total = firstData + dataSectors;

  const fat = new Uint32Array(fatSectors * ENTRIES_PER_SECTOR).fill(SECTOR.free);
  fat.fill(SECTOR.fat, 0, fatSectors);
  fat[directorySector] = SECTOR.endOfChain;
  if (mini) {
    fat[miniFatSector] = SECTOR.endOfChain;
  }
  for (let index = firstData; index < total; index += 1) {
    fat[index] = index === total - 1 ? SECTOR.endOfChain : index + 1;
  }

  const out = new Uint8Array((total + 1) * SECTOR_BYTES);
  const view = new DataView(out.buffer);
  const sectorOffset = (sector: number): number => (sector + 1) * SECTOR_BYTES;
  view.setBigUint64(0, SIGNATURE, true);
  view.setUint16(HEADER.minorVersion, HEADER_VALUES.minorVersion, true);
  view.setUint16(HEADER.majorVersion, HEADER_VALUES.majorVersion, true);
  view.setUint16(HEADER.byteOrder, HEADER_VALUES.byteOrder, true);
  view.setUint16(HEADER.sectorShift, HEADER_VALUES.sectorShift, true);
  view.setUint16(HEADER.miniSectorShift, HEADER_VALUES.miniSectorShift, true);
  view.setUint32(HEADER.fatSectors, fatSectors, true);
  view.setUint32(HEADER.firstDirectorySector, directorySector, true);
  view.setUint32(HEADER.miniStreamCutoff, MINI_STREAM_CUTOFF, true);
  view.setUint32(HEADER.firstMiniFatSector, mini ? miniFatSector : SECTOR.endOfChain, true);
  view.setUint32(HEADER.miniFatSectors, miniFatSectors, true);
  view.setUint32(HEADER.firstDifatSector, SECTOR.endOfChain, true);
  view.setUint32(HEADER.difatSectors, 0, true);
  for (let index = 0; index < HEADER_DIFAT_ENTRIES; index += 1) {
    view.setUint32(HEADER.difat + index * U32, index < fatSectors ? index : SECTOR.free, true);
  }
  for (const [index, entry] of fat.entries()) {
    view.setUint32(sectorOffset(0) + index * U32, entry, true);
  }

  const directoryEntry = (slot: number, entry: { readonly name: string; readonly type: number; readonly child: number; readonly start: number; readonly size: number } | undefined): void => {
    const base = sectorOffset(directorySector) + slot * DIRECTORY_ENTRY_BYTES;
    view.setUint32(base + ENTRY.left, SECTOR.noStream, true);
    view.setUint32(base + ENTRY.right, SECTOR.noStream, true);
    view.setUint32(base + ENTRY.child, entry?.child ?? SECTOR.noStream, true);
    if (entry === undefined) {
      return;
    }
    for (let index = 0; index < entry.name.length; index += 1) {
      view.setUint16(base + index * U16, entry.name.charCodeAt(index), true);
    }
    view.setUint16(base + ENTRY.nameLength, (entry.name.length + 1) * U16, true);
    view.setUint8(base + ENTRY.type, entry.type);
    view.setUint8(base + ENTRY.colour, BLACK);
    view.setUint32(base + ENTRY.start, entry.start, true);
    view.setUint32(base + ENTRY.size, entry.size, true);
  };
  directoryEntry(0, { name: "Root Entry", type: OBJECT.root, child: 1, start: mini ? firstData : SECTOR.endOfChain, size: mini ? miniStreamBytes : 0 });
  directoryEntry(1, { name, type: OBJECT.stream, child: SECTOR.noStream, start: mini ? 0 : firstData, size: stream.length });
  for (let slot = 2; slot < DIRECTORY_SLOTS; slot += 1) {
    directoryEntry(slot, undefined);
  }
  if (mini) {
    const miniSectors = miniStreamBytes / MINI_SECTOR_BYTES;
    for (let index = 0; index < ENTRIES_PER_SECTOR; index += 1) {
      view.setUint32(sectorOffset(miniFatSector) + index * U32, index < miniSectors ? (index === miniSectors - 1 ? SECTOR.endOfChain : index + 1) : SECTOR.free, true);
    }
  }
  out.set(stream, sectorOffset(firstData));

  return out;
}

/**
 * Writes an xls workbook: a compound file whose Workbook stream holds the sheets and globals given.
 * @param sheets - Each sheet's records, by name.
 * @param globals - What else the globals hold.
 * @returns The file.
 */
export function xlsWorkbook(sheets: Readonly<Record<string, readonly BiffRecord[]>>, globals: Readonly<Globals> = {}): Uint8Array {
  return compoundFile("Workbook", workbookStream(sheets, globals));
}
