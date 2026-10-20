import { ArchiveError } from "../errors";
import { POINT_COLUMNS } from "../parsers/geojson";
import { csvField } from "./csv-text";
import { toWgs84Of, type ToWgs84 } from "./projection";

/** The parts of a shapefile a point layer is read from: the geometry (`.shp`), the attribute table (`.dbf`), the coordinate system (`.prj`) and the attribute table's text encoding (`.cpg`). */
export interface ShapefileParts {
  readonly shp: Uint8Array;
  readonly dbf: Uint8Array;
  readonly prj: Uint8Array;
  readonly cpg: Uint8Array;
}

/** The columns a point's position fills after the attribute table's: its coordinates as the shapefile stores them, then its WGS84 latitude and longitude, the same names the geojson parser gives a point feature's position. */
export const SHAPEFILE_POINT_COLUMNS = ["geometry_x", "geometry_y", POINT_COLUMNS.latitude, POINT_COLUMNS.longitude] as const;

/** The `.shp` file code and version every shapefile starts with (ESRI Shapefile Technical Description, 1998). */
const SHP_FILE_CODE = 9994;
const SHP_VERSION = 1000;
const SHP_HEADER_BYTES = 100;
const SHP_RECORD_HEADER_BYTES = 8;
/** Bytes in the 16-bit word the `.shp` measures lengths in. */
const SHP_WORD_BYTES = 2;
const SHP_VERSION_OFFSET = 28;
const SHP_TYPE_OFFSET = 32;
/** The shape types of a point layer: the null shape (no position), and the point with x and y, with a measure (`PointM`) or with z and a measure (`PointZ`), whose x and y come first. */
const SHAPE = { null: 0, point: 1, pointZ: 11, pointM: 21 } as const;
const POINT_TYPES: ReadonlySet<number> = new Set([SHAPE.point, SHAPE.pointZ, SHAPE.pointM]);
const COORDINATE_BYTES = 8;
const SHAPE_TYPE_BYTES = 4;

/** The dBASE header's offsets: the record count, the header's length and one record's length, then the field descriptors from byte 32, each 32 bytes, ended by a carriage return (dBASE III and later). */
const DBF = { recordCount: 4, headerLength: 8, recordLength: 10, firstField: 32, fieldBytes: 32, nameBytes: 11, typeOffset: 11, lengthOffset: 16, terminator: 0x0d } as const;
/** The first byte of a dBASE record: a space for a live record and an asterisk for a deleted one. */
const LIVE_RECORD = 0x20;
const DATE_DIGITS = 8;
const YEAR_DIGITS = 4;
const MONTH_END = 6;

/** Decodes one field's bytes to text. */
type Decode = (bytes: Uint8Array) => string;

/** The text encodings a `.cpg` may name, by the names a `.cpg` writes them with, compared without case, spaces, hyphens or underscores. ISO-8859-1 maps each byte to the code point of the same value and is decoded so, not with `TextDecoder`'s "latin1" label, which the WHATWG Encoding Standard maps to windows-1252 and so reads bytes 0x80 to 0x9F differently. */
const CPG_ENCODINGS: ReadonlyMap<string, () => Decode> = new Map<string, () => Decode>([
  [
    "utf8",
    () => {
      const decoder = new TextDecoder("utf-8", { fatal: true });

      return (bytes) => decoder.decode(bytes);
    },
  ],
  ["88591", () => (bytes) => String.fromCharCode(...bytes)],
  ["iso88591", () => (bytes) => String.fromCharCode(...bytes)],
]);

/** One field of a dBASE table: its name, its type letter, where its bytes start in a record and how many there are. */
interface DbfField {
  readonly name: string;
  readonly type: string;
  readonly offset: number;
  readonly length: number;
}

/**
 * The decoder of the text encoding a `.cpg` names.
 * @param cpg - The `.cpg` file.
 * @returns The decoder, strict for UTF-8 so bytes that are not valid fail rather than becoming replacement characters.
 * @throws ArchiveError when it names an encoding keepset does not decode.
 */
function decoderOf(cpg: Uint8Array): Decode {
  const named = new TextDecoder("utf-8").decode(cpg).trim();
  const encoding = CPG_ENCODINGS.get(named.toLowerCase().replaceAll(/[\s_-]+/g, ""));
  if (encoding === undefined) {
    throw new ArchiveError(`the .cpg names the encoding ${JSON.stringify(named)}, and keepset decodes a shapefile's attributes only in UTF-8 or ISO-8859-1`);
  }

  return encoding();
}

/**
 * Reads a dBASE table's field descriptors.
 * @param dbf - The `.dbf` file.
 * @param decode - Decodes the field names.
 * @returns The record count, the header and record lengths, and the fields in order.
 * @throws ArchiveError when the header is cut short, a field is a memo or other type kept outside the table, or the fields do not fill a record.
 */
function dbfLayout(dbf: Uint8Array, decode: Decode): { readonly records: number; readonly headerLength: number; readonly recordLength: number; readonly fields: readonly DbfField[] } {
  if (dbf.length < DBF.firstField + 1) {
    throw new ArchiveError("the .dbf is shorter than a dBASE header");
  }
  const view = new DataView(dbf.buffer, dbf.byteOffset, dbf.byteLength);
  const headerLength = view.getUint16(DBF.headerLength, true);
  const recordLength = view.getUint16(DBF.recordLength, true);
  const fields: DbfField[] = [];
  let offset = 1;
  for (let at = DBF.firstField; dbf[at] !== DBF.terminator; at += DBF.fieldBytes) {
    if (at + DBF.fieldBytes > headerLength) {
      throw new ArchiveError("the .dbf's field descriptors run past its header without the terminator");
    }
    const nameBytes = dbf.subarray(at, at + DBF.nameBytes);
    const end = nameBytes.indexOf(0);
    const name = decode(end === -1 ? nameBytes : nameBytes.subarray(0, end));
    const type = String.fromCharCode(dbf[at + DBF.typeOffset] ?? 0);
    const length = dbf[at + DBF.lengthOffset] ?? 0;
    if (!["C", "N", "F", "D", "L"].includes(type)) {
      throw new ArchiveError(`the .dbf field ${name} has the type ${JSON.stringify(type)}, which keeps its value outside the table or is not one keepset reads (it reads C, N, F, D and L)`);
    }
    fields.push({ name, type, offset, length });
    offset += length;
  }
  if (offset !== recordLength) {
    throw new ArchiveError(`the .dbf's fields fill ${String(offset)} bytes of a record its header says is ${String(recordLength)}`);
  }

  return { records: view.getUint32(DBF.recordCount, true), headerLength, recordLength, fields };
}

/**
 * One dBASE value as the text of a CSV cell: character text trimmed, a number as written (an overflowed field of asterisks is empty, as dBASE writes no value that way), a date `YYYYMMDD` as ISO 8601 (all zeros or blank is empty), and a logical as `true` or `false` (`?` or blank is empty).
 * @param bytes - The field's bytes in the record.
 * @param field - The field.
 * @param decode - Decodes character text.
 * @param record - The 1-based record number, for errors.
 * @returns The cell text, empty for no value.
 * @throws ArchiveError when a date or logical value is malformed.
 */
function cellOf(bytes: Uint8Array, field: DbfField, decode: Decode, record: number): string {
  const text = decode(bytes).trim();
  if (field.type === "C") {
    return text;
  }
  if (field.type === "N" || field.type === "F") {
    return /^\**$/.test(text) ? "" : text;
  }
  if (field.type === "D") {
    if (text === "" || /^0+$/.test(text)) {
      return "";
    }
    if (!new RegExp(`^\\d{${String(DATE_DIGITS)}}$`).test(text)) {
      throw new ArchiveError(`record ${String(record)} has the date ${JSON.stringify(text)} in ${field.name}, not YYYYMMDD`);
    }

    return `${text.slice(0, YEAR_DIGITS)}-${text.slice(YEAR_DIGITS, MONTH_END)}-${text.slice(MONTH_END)}`;
  }
  if (text === "" || text === "?") {
    return "";
  }
  if (/^[TtYy]$/.test(text)) {
    return "true";
  }
  if (/^[FfNn]$/.test(text)) {
    return "false";
  }
  throw new ArchiveError(`record ${String(record)} has the logical value ${JSON.stringify(text)} in ${field.name}`);
}

/**
 * Reads a point shapefile's positions in record order.
 * @param shp - The `.shp` file.
 * @returns Each record's x and y, or undefined for a null shape.
 * @throws ArchiveError when the file is not a shapefile, a record is not a point or the null shape, or the records are not numbered in order.
 */
function pointsOf(shp: Uint8Array): ({ readonly x: number; readonly y: number } | undefined)[] {
  const view = new DataView(shp.buffer, shp.byteOffset, shp.byteLength);
  if (shp.length < SHP_HEADER_BYTES || view.getInt32(0, false) !== SHP_FILE_CODE || view.getInt32(SHP_VERSION_OFFSET, true) !== SHP_VERSION) {
    throw new ArchiveError("the .shp is not a shapefile: it lacks the file code and version a shapefile starts with");
  }
  const layerType = view.getInt32(SHP_TYPE_OFFSET, true);
  if (!POINT_TYPES.has(layerType) && layerType !== SHAPE.null) {
    throw new ArchiveError(`the .shp holds shapes of type ${String(layerType)}, not points, and keepset reads only point shapefiles`);
  }
  const points: ({ readonly x: number; readonly y: number } | undefined)[] = [];
  for (let at = SHP_HEADER_BYTES; at < shp.length; ) {
    if (at + SHP_RECORD_HEADER_BYTES + SHAPE_TYPE_BYTES > shp.length) {
      throw new ArchiveError(`the .shp ends inside the header of record ${String(points.length + 1)}`);
    }
    const number = view.getInt32(at, false);
    const length = view.getInt32(at + SHAPE_TYPE_BYTES, false) * SHP_WORD_BYTES;
    if (number !== points.length + 1) {
      throw new ArchiveError(`the .shp's record ${String(points.length + 1)} is numbered ${String(number)}`);
    }
    const content = at + SHP_RECORD_HEADER_BYTES;
    if (content + length > shp.length) {
      throw new ArchiveError(`the .shp ends inside record ${String(number)}`);
    }
    const type = view.getInt32(content, true);
    if (type === SHAPE.null) {
      points.push(undefined);
    } else if (POINT_TYPES.has(type) && length >= SHAPE_TYPE_BYTES + 2 * COORDINATE_BYTES) {
      points.push({ x: view.getFloat64(content + SHAPE_TYPE_BYTES, true), y: view.getFloat64(content + SHAPE_TYPE_BYTES + COORDINATE_BYTES, true) });
    } else {
      throw new ArchiveError(`the .shp's record ${String(number)} is a shape of type ${String(type)}, not a point`);
    }
    at = content + length;
  }

  return points;
}

/**
 * The position cells of a point, in the order of `SHAPEFILE_POINT_COLUMNS`.
 * @param x - The stored x.
 * @param y - The stored y.
 * @param toWgs84 - The conversion the `.prj` defines.
 * @returns The stored x and y, then the WGS84 latitude and longitude.
 */
function positionCells(x: number, y: number, toWgs84: ToWgs84): string[] {
  const { latitude, longitude } = toWgs84(x, y);

  return [String(x), String(y), String(latitude), String(longitude)];
}

/**
 * Writes a point shapefile as CSV text, so a recipe reads it with the table parser: a header of the attribute table's field names followed by `geometry_x`, `geometry_y`, `geometry_latitude` and `geometry_longitude`, then one line per record in file order with its attributes (`cellOf` says how each is written), its coordinates as the shapefile stores them, and its position in WGS84 degrees, converted by the coordinate system the `.prj` defines (`toWgs84Of`). A record whose shape is null has empty position cells.
 * @param parts - The shapefile's parts.
 * @returns The CSV, in UTF-8.
 * @throws ArchiveError when a part is malformed, the geometry is not points, the geometry and the attribute table hold different numbers of records, an attribute record is marked deleted (it would leave the table and the geometry paired by nothing), a field is named like a position column, or the coordinate system is not one keepset converts.
 */
export function pointShapefileToCsv(parts: ShapefileParts): Uint8Array {
  const toWgs84 = toWgs84Of(new TextDecoder("utf-8").decode(parts.prj));
  const decode = decoderOf(parts.cpg);
  const layout = dbfLayout(parts.dbf, decode);
  const points = pointsOf(parts.shp);
  if (points.length !== layout.records) {
    throw new ArchiveError(`the .shp holds ${String(points.length)} records and the .dbf ${String(layout.records)}, so they do not pair`);
  }
  if (parts.dbf.length < layout.headerLength + layout.records * layout.recordLength) {
    throw new ArchiveError(`the .dbf ends before its ${String(layout.records)} records`);
  }
  const clash = layout.fields.find((field) => SHAPEFILE_POINT_COLUMNS.some((column) => column === field.name));
  if (clash !== undefined) {
    throw new ArchiveError(`the .dbf has a field named ${clash.name}, which is a column of the point's position`);
  }
  const lines = [[...layout.fields.map((field) => field.name), ...SHAPEFILE_POINT_COLUMNS].map(csvField).join(",")];
  points.forEach((point, index) => {
    const start = layout.headerLength + index * layout.recordLength;
    if (parts.dbf[start] !== LIVE_RECORD) {
      throw new ArchiveError(`the .dbf's record ${String(index + 1)} is marked deleted`);
    }
    const cells = layout.fields.map((field) => cellOf(parts.dbf.subarray(start + field.offset, start + field.offset + field.length), field, decode, index + 1));
    const geometry = point === undefined ? SHAPEFILE_POINT_COLUMNS.map(() => "") : positionCells(point.x, point.y, toWgs84);
    lines.push([...cells, ...geometry].map(csvField).join(","));
  });

  return new TextEncoder().encode(`${lines.join("\n")}\n`);
}
