import { z } from "zod";
import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import type { NativeRow, NativeTable } from "./native";

type GeojsonParser = Extract<Parser, { format: "geojson" }>;

/** The columns a point feature's position fills, which no property may share a name with: the latitude and the longitude of a `Point` geometry, and null for a feature with any other geometry or none. */
export const POINT_COLUMNS = { latitude: "geometry_latitude", longitude: "geometry_longitude" } as const;

const FeatureCollectionSchema = z.object({
  type: z.literal("FeatureCollection"),
  features: z.array(z.object({ geometry: z.object({ type: z.string(), coordinates: z.unknown() }).nullable(), properties: z.record(z.string(), z.unknown()).nullable() })),
});

/**
 * The position of a point geometry.
 * @param geometry - The feature's geometry.
 * @returns The longitude and latitude of a `Point`, and undefined for any other geometry or none.
 */
function pointOf(geometry: { readonly type: string; readonly coordinates?: unknown } | null): { readonly longitude: number; readonly latitude: number } | undefined {
  const coordinates = z.array(z.unknown()).safeParse(geometry?.type === "Point" ? geometry.coordinates : undefined);
  if (!coordinates.success) {
    return undefined;
  }
  const [longitude, latitude] = coordinates.data;

  return typeof longitude === "number" && typeof latitude === "number" ? { longitude, latitude } : undefined;
}

/**
 * One cell of a feature, in the form its column is declared to take.
 * @param value - The property's value, or undefined when the feature lacks it.
 * @param column - The column, for the error.
 * @param feature - The 1-based feature number, for the error.
 * @param kind - How the column is read: as a number times a factor, as an epoch-millisecond date written in ISO 8601, or as text.
 * @returns The cell: null for a missing, null or empty value.
 * @throws NativeParseError when the value is not the kind the recipe declares.
 */
function cellOf(value: unknown, column: string, feature: number, kind: { readonly factor: number } | "date" | "text"): string | number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (kind === "date") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new NativeParseError("geojson", feature, `column ${column} is declared a date but holds ${JSON.stringify(value)}`);
    }

    return new Date(value).toISOString();
  }
  if (kind !== "text") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new NativeParseError("geojson", feature, `column ${column} is declared numeric but holds ${JSON.stringify(value)}`);
    }

    return value * kind.factor;
  }
  if (typeof value === "string") {
    return value.trim() === "" ? null : value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  throw new NativeParseError("geojson", feature, `column ${column} holds a ${Array.isArray(value) ? "list" : "nested object"}, which a column cannot`);
}

/**
 * Parses a GeoJSON feature collection into rows, one per feature in file order: the properties the recipe lists become columns, a point's position fills `geometry_latitude` and `geometry_longitude` when they are listed, and an id comes from the recipe's id column (not also a column) or the feature's 1-based number. A column declared numeric is a number times its factor, one declared a date is an epoch-millisecond number written as an ISO 8601 text, and any other is text (a number or flag is written as its text), an empty or missing value being null so every row carries every column.
 * @param text - The file text.
 * @param options - The recipe's parser.
 * @returns The rows.
 * @throws NativeParseError when the text is not a GeoJSON feature collection, a value is not the kind its column is declared, a listed column is also a point column of another name, or an id is empty.
 */
export function parseGeojson(text: string, options: GeojsonParser): NativeTable {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new NativeParseError("geojson", 1, `the file is not JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  const collection = FeatureCollectionSchema.safeParse(document);
  if (!collection.success) {
    throw new NativeParseError("geojson", 1, `the file is not a GeoJSON feature collection (${collection.error.issues.map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`).join("; ")})`);
  }
  const factors = new Map(options.numericColumns.map((numeric) => [numeric.column, numeric.factor]));
  const dates = new Set(options.dateColumns);
  const kinds = options.columns.map((column) => {
    const factor = factors.get(column);

    return { column, kind: factor === undefined ? (dates.has(column) ? ("date" as const) : ("text" as const)) : { factor } };
  });

  const nodes = collection.data.features.map((feature, index): NativeRow => {
    const number = index + 1;
    const properties = feature.properties ?? {};
    const point = pointOf(feature.geometry);
    const own = (column: string): unknown => (Object.hasOwn(properties, column) ? properties[column] : undefined);
    const id = options.idColumn === null ? String(number) : cellOf(own(options.idColumn), options.idColumn, number, "text");
    if (id === null) {
      throw new NativeParseError("geojson", number, `the id column ${options.idColumn ?? ""} is empty`);
    }
    const cells = kinds.map(({ column, kind }): [string, string | number | null] => {
      if (column === POINT_COLUMNS.latitude || column === POINT_COLUMNS.longitude) {
        if (Object.hasOwn(properties, column)) {
          throw new NativeParseError("geojson", number, `a property is named ${column}, which is the column of the point's position`);
        }
        const position = column === POINT_COLUMNS.latitude ? point?.latitude : point?.longitude;

        return [column, position === undefined ? null : position * (typeof kind === "object" ? kind.factor : 1)];
      }

      return [column, cellOf(own(column), column, number, kind)];
    });

    return { ...Object.fromEntries(cells), id: String(id) };
  });

  return { nodes };
}
