import { describe, expect, it } from "vitest";
import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import { parseNative } from "./parse-native";

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** The feature number the test below with a malformed second feature expects its error on. */
const SECOND_FEATURE = 2;
/** A point in Camden. */
const CAMDEN_LONGITUDE = -0.1;
const CAMDEN_LATITUDE = 51.5;
/** An epoch-millisecond date and the ISO 8601 text it is written as. */
const EPOCH_MILLISECONDS = 1_700_000_000_000;
const EPOCH_TEXT = "2023-11-14T22:13:20.000Z";

const geojson = (options: Partial<Extract<Parser, { format: "geojson" }>> = {}): Extract<Parser, { format: "geojson" }> => ({
  format: "geojson",
  encoding: "utf-8",
  idColumn: null,
  numericColumns: [],
  dateColumns: [],
  columns: ["a"],
  ...options,
});

const collection = (...features: readonly unknown[]): string => JSON.stringify({ type: "FeatureCollection", features });
const feature = (properties: unknown, geometry: unknown = null): unknown => ({ type: "Feature", geometry, properties });

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

describe("the geojson parser", () => {
  it("reads one row per feature, numbering them when the recipe names no id column, with the listed properties as columns", () => {
    expect(parseNative(utf8(collection(feature({ a: "x", b: "dropped" }), feature({ a: "y" }))), geojson()).nodes).toEqual([
      { id: "1", a: "x" },
      { id: "2", a: "y" },
    ]);
  });

  it("takes the id from the recipe's id column, which is then not also a column, as text", () => {
    expect(parseNative(utf8(collection(feature({ key: 7, a: "x" }))), geojson({ idColumn: "key" })).nodes).toEqual([{ id: "7", a: "x" }]);
  });

  it("makes a missing, null or empty value null in every row, and trims text", () => {
    expect(parseNative(utf8(collection(feature({ a: "  x ", b: "" }), feature({ a: null }), feature({}))), geojson({ columns: ["a", "b"] })).nodes).toEqual([
      { id: "1", a: "x", b: null },
      { id: "2", a: null, b: null },
      { id: "3", a: null, b: null },
    ]);
  });

  it("reads a declared numeric column as a number times its factor, a date as ISO 8601 text, and any other value as text", () => {
    const parser = geojson({ columns: ["n", "when", "flag", "count"], numericColumns: [{ column: "n", factor: 60 }], dateColumns: ["when"] });
    expect(parseNative(utf8(collection(feature({ n: 2, when: EPOCH_MILLISECONDS, flag: true, count: 4 }))), parser).nodes).toEqual([{ id: "1", n: 120, when: EPOCH_TEXT, flag: "true", count: "4" }]);
  });

  it("fills the point columns from a Point's position, longitude first in the file, and null for any other geometry or none", () => {
    const parser = geojson({ columns: ["geometry_latitude", "geometry_longitude"], numericColumns: [{ column: "geometry_latitude", factor: 1 }, { column: "geometry_longitude", factor: 1 }] });
    const rows = parseNative(utf8(collection(feature({}, { type: "Point", coordinates: [CAMDEN_LONGITUDE, CAMDEN_LATITUDE] }), feature({}, { type: "LineString", coordinates: [[0, 0]] }), feature({}), feature({}, { type: "Point", coordinates: [] }))), parser).nodes;
    expect(rows).toEqual([
      { id: "1", geometry_latitude: CAMDEN_LATITUDE, geometry_longitude: CAMDEN_LONGITUDE },
      { id: "2", geometry_latitude: null, geometry_longitude: null },
      { id: "3", geometry_latitude: null, geometry_longitude: null },
      { id: "4", geometry_latitude: null, geometry_longitude: null },
    ]);
  });

  it("refuses a value that is not the kind its column is declared, naming the feature", () => {
    const numeric = parseError(() => parseNative(utf8(collection(feature({ n: 1 }), feature({ n: "x" }))), geojson({ columns: ["n"], numericColumns: [{ column: "n", factor: 1 }] })));
    expect(numeric.message).toMatch(/column n is declared numeric but holds "x"/);
    expect(numeric.line).toBe(SECOND_FEATURE);
    expect(parseError(() => parseNative(utf8(collection(feature({ d: "yesterday" }))), geojson({ columns: ["d"], dateColumns: ["d"] }))).message).toMatch(/declared a date/);
    expect(parseError(() => parseNative(utf8(collection(feature({ a: { nested: 1 } }))), geojson())).message).toMatch(/nested object/);
    expect(parseError(() => parseNative(utf8(collection(feature({ a: [1] }))), geojson())).message).toMatch(/list/);
  });

  it("refuses an empty id, a property that takes a point column's name, and text that is not a feature collection", () => {
    expect(parseError(() => parseNative(utf8(collection(feature({ key: null, a: 1 }))), geojson({ idColumn: "key" }))).message).toMatch(/id column key is empty/);
    expect(parseError(() => parseNative(utf8(collection(feature({ geometry_latitude: 1 }))), geojson({ columns: ["geometry_latitude"] }))).message).toMatch(/column of the point's position/);
    expect(parseError(() => parseNative(utf8("not json"), geojson())).message).toMatch(/not JSON/);
    expect(parseError(() => parseNative(utf8('{"type":"Feature"}'), geojson())).message).toMatch(/not a GeoJSON feature collection/);
  });

  it("keeps a property named like an inherited one as a column of its own", () => {
    const [row] = parseNative(utf8(collection(feature({ constructor: "x" }))), geojson({ columns: ["constructor"] })).nodes;
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
    expect(row).toEqual({ id: "1", constructor: "x" });
    expect(parseNative(utf8(collection(feature({}))), geojson({ columns: ["constructor"] })).nodes).toEqual([{ id: "1", constructor: null }]);
  });
});
