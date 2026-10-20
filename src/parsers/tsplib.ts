import { NativeParseError } from "../errors";
import { lines, type NativeInstance, type NativeRow } from "./native";

/** The columns of a node of a TSPLIB orienteering file, as the parser names them. `x` and `y` are planar coordinates (`CEIL_2D`, `EUC_2D`, `ATT`), `lat` and `lon` decimal degrees (`GEO`), `prize` and `probability` the node's prize and the chance it is collected (a probabilistic orienteering file), and `clusters` the ids of the sets the node belongs to, comma separated (a clustered orienteering file). A column a file has no data for is null in every row, so every row has every column. */
export const TSPLIB_COLUMNS = ["x", "y", "lat", "lon", "prize", "probability", "clusters"] as const;

/** The metadata keys the parser reads: the instance's name and type, its travel budget, the weight type its coordinates are in, the sum of its prizes (probabilistic files) and its sets with their prizes as `id:prize` pairs (clustered files). A key a file does not have is null. */
export const TSPLIB_META = ["name", "type", "budget", "edgeWeightType", "totalPrize", "setPrizes"] as const;

const FORMAT = "tsplib";

/** The instance types the parser reads: the probabilistic and the clustered orienteering problem. */
const TYPES: ReadonlySet<string> = new Set(["POP", "COP"]);

/** The edge weight types a coordinate section is read under: planar ones keep their coordinates as `x` and `y`, `GEO` converts them to degrees, and `EXPLICIT` has no coordinates. */
const PLANAR: ReadonlySet<string> = new Set(["EUC_2D", "CEIL_2D", "ATT"]);

const NUMBER = /^-?\d+(?:\.\d+)?$/;
const WHOLE = /^\d+$/;
const HEADER = /^([A-Z][A-Z_]*)\s*:\s*(.*)$/;
const SECTION = /^[A-Z][A-Z_]*$/;

/** Sections whose rows the parser reads; any other section (the weight matrix, display data) is skipped. */
type Section = "coords" | "prizes" | "sets" | "skipped";

/** Minutes in a degree, which a `DDD.MM` coordinate counts in. */
const MINUTES_PER_DEGREE = 60;
/** `DDD.MM` has two digits of minutes, so the fraction is read in hundredths. */
const MINUTE_SCALE = 100;
/** How far a coordinate's hundredths may lie from a whole number of minutes: float error in the text's value, not a third digit. */
const MINUTE_TOLERANCE = 1e-6;

/**
 * Converts a TSPLIB `GEO` coordinate to decimal degrees. The value is `DDD.MM`, degrees then minutes in one number (`48.23` is 48 degrees 23 minutes), so the fraction is minutes out of a hundred, not a decimal fraction of a degree. The degrees are truncated, which is what makes the conversion agree with the optimal tour lengths the instances record where the specification's `nint` would round minutes of 50 or more up to the next degree.
 * @param value - The coordinate as the file writes it.
 * @param line - The 1-based line, for the error.
 * @returns Decimal degrees, signed like the input.
 * @throws NativeParseError when the minutes are not a whole number below sixty.
 */
function degrees(value: number, line: number): number {
  const magnitude = Math.abs(value);
  const whole = Math.trunc(magnitude);
  const hundredths = (magnitude - whole) * MINUTE_SCALE;
  const minutes = Math.round(hundredths);
  if (Math.abs(hundredths - minutes) > MINUTE_TOLERANCE || minutes >= MINUTES_PER_DEGREE) {
    throw new NativeParseError(FORMAT, line, `expected a DDD.MM coordinate with whole minutes below 60, found ${String(value)}`);
  }

  return Math.sign(value) * (whole + minutes / MINUTES_PER_DEGREE);
}

/**
 * Reads a token as a finite number.
 * @param token - The token.
 * @param line - The 1-based line, for the error.
 * @param what - What the token should be, for the error.
 * @returns The number.
 * @throws NativeParseError when the token is not a decimal number.
 */
function numberOf(token: string | undefined, line: number, what: string): number {
  if (token === undefined || !NUMBER.test(token)) {
    throw new NativeParseError(FORMAT, line, `expected ${what}, found ${JSON.stringify(token)}`);
  }

  return Number(token);
}

/**
 * Reads a token as a whole number.
 * @param token - The token.
 * @param line - The 1-based line, for the error.
 * @param what - What the token should be, for the error.
 * @returns The number.
 * @throws NativeParseError when the token is not a whole number.
 */
function wholeOf(token: string | undefined, line: number, what: string): number {
  if (token === undefined || !WHOLE.test(token)) {
    throw new NativeParseError(FORMAT, line, `expected ${what}, found ${JSON.stringify(token)}`);
  }

  return Number(token);
}

/** What the parser collects from a file before it builds the nodes. */
interface Collected {
  readonly header: Map<string, string>;
  readonly coords: Map<number, { readonly x: number; readonly y: number; readonly line: number }>;
  readonly prizes: Map<number, { readonly prize: number; readonly probability: number }>;
  readonly sets: { readonly id: number; readonly prize: number; readonly members: readonly number[] }[];
}

/**
 * Reads the header, the coordinate section, the prize and probability section and the set section of a file, skipping every other section.
 * @param text - The file text.
 * @returns What it holds.
 * @throws NativeParseError naming the line for a repeated key, a malformed row, a repeated node or set id, or a row outside any section.
 */
function collect(text: string): Collected {
  const collected: Collected = { header: new Map(), coords: new Map(), prizes: new Map(), sets: [] };
  let section: Section | undefined;
  for (const [index, raw] of lines(text).entries()) {
    const line = index + 1;
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed === "EOF") {
      continue;
    }
    const keyed = HEADER.exec(trimmed);
    const key = keyed?.[1];
    if (key === "CONSTRAINING_SET_SECTION") {
      section = "sets";
      continue;
    }
    if (keyed !== null && key !== undefined) {
      if (collected.header.has(key)) {
        throw new NativeParseError(FORMAT, line, `${key} appears twice`);
      }
      collected.header.set(key, (keyed[2] ?? "").trim());
      section = undefined;
      continue;
    }
    if (SECTION.test(trimmed)) {
      section = trimmed === "NODE_COORD_SECTION" ? "coords" : trimmed === "NODE_PRIZE_PROBABILITY_SECTION" ? "prizes" : "skipped";
      continue;
    }
    const tokens = trimmed.split(/\s+/);
    if (section === "coords") {
      const [id, x, y, ...extra] = tokens;
      if (extra.length > 0) {
        throw new NativeParseError(FORMAT, line, `expected "id x y", found ${JSON.stringify(trimmed)}`);
      }
      const node = wholeOf(id, line, "a node id");
      if (collected.coords.has(node)) {
        throw new NativeParseError(FORMAT, line, `node ${String(node)} has two coordinate rows`);
      }
      collected.coords.set(node, { x: numberOf(x, line, "x"), y: numberOf(y, line, "y"), line });
    } else if (section === "prizes") {
      const [id, prize, probability, ...extra] = tokens;
      if (extra.length > 0) {
        throw new NativeParseError(FORMAT, line, `expected "id prize probability", found ${JSON.stringify(trimmed)}`);
      }
      const node = wholeOf(id, line, "a node id");
      if (collected.prizes.has(node)) {
        throw new NativeParseError(FORMAT, line, `node ${String(node)} has two prize rows`);
      }
      collected.prizes.set(node, { prize: numberOf(prize, line, "the prize"), probability: numberOf(probability, line, "the probability") });
    } else if (section === "sets") {
      const [id, prize, ...members] = tokens;
      const setId = wholeOf(id, line, "a set id");
      if (collected.sets.some((set) => set.id === setId)) {
        throw new NativeParseError(FORMAT, line, `set ${String(setId)} appears twice`);
      }
      collected.sets.push({ id: setId, prize: numberOf(prize, line, "the set prize"), members: members.map((member) => wholeOf(member, line, "a node id in a set")) });
    } else if (section === undefined) {
      throw new NativeParseError(FORMAT, line, `expected a KEY : value line or a section, found ${JSON.stringify(trimmed)}`);
    }
  }

  return collected;
}

/**
 * Reads a header value that must be there.
 * @param header - The header.
 * @param key - The key.
 * @returns Its text.
 * @throws NativeParseError when the file has no such key.
 */
function required(header: ReadonlyMap<string, string>, key: string): string {
  const value = header.get(key);
  if (value === undefined) {
    throw new NativeParseError(FORMAT, 1, `expected a ${key} line`);
  }

  return value;
}

/**
 * Parses a TSPLIB style orienteering instance of type `POP` (probabilistic orienteering, Angelelli and others) or `COP` (clustered orienteering), in the layout TSPLIB95 (Reinelt) defines: `KEY : value` header lines and bare keyword sections. The nodes are 1 to `DIMENSION`. The planar weight types keep their coordinates as `x` and `y` and `GEO` converts them to `lat` and `lon`; an `EXPLICIT` file has no coordinates, so its nodes have only the prize data. A `POP` file's `NODE_PRIZE_PROBABILITY_SECTION` gives each node its prize and probability. A `COP` file has no prize on a node: its prizes belong to sets of nodes that may overlap, so each node lists the sets it is in under `clusters` and the sets' prizes are the `setPrizes` metadata, and nothing is divided among the members. The weight matrix is not read, as or/v1 has no arcs.
 * @param text - The file text.
 * @returns The instance: its header values as `meta` and its nodes in id order.
 * @throws NativeParseError naming the line for an unsupported type or weight type, a missing key or section, a node id outside 1 to `DIMENSION` or missing from a section that must cover every node, or a set that names a node outside that range.
 */
export function parseTsplib(text: string): NativeInstance {
  const { header, coords, prizes, sets } = collect(text);
  const type = required(header, "TYPE");
  if (!TYPES.has(type)) {
    throw new NativeParseError(FORMAT, 1, `expected TYPE POP or COP, found ${JSON.stringify(type)}`);
  }
  const weightType = required(header, "EDGE_WEIGHT_TYPE");
  const geographic = weightType === "GEO";
  if (!geographic && !PLANAR.has(weightType) && weightType !== "EXPLICIT") {
    throw new NativeParseError(FORMAT, 1, `expected EDGE_WEIGHT_TYPE EUC_2D, CEIL_2D, ATT, GEO or EXPLICIT, found ${JSON.stringify(weightType)}`);
  }
  const dimension = wholeOf(required(header, "DIMENSION"), 1, "DIMENSION");
  const budget = numberOf(required(header, "TMAX"), 1, "TMAX");
  if (weightType === "EXPLICIT" ? coords.size > 0 : coords.size !== dimension) {
    throw new NativeParseError(FORMAT, 1, weightType === "EXPLICIT" ? "an EXPLICIT file has no NODE_COORD_SECTION" : `expected ${String(dimension)} coordinate rows, found ${String(coords.size)}`);
  }
  const inRange = (id: number): boolean => id >= 1 && id <= dimension;
  for (const id of [...coords.keys(), ...prizes.keys(), ...sets.flatMap((set) => set.members)]) {
    if (!inRange(id)) {
      throw new NativeParseError(FORMAT, 1, `node ${String(id)} is outside 1 to ${String(dimension)}`);
    }
  }
  if (type === "POP" && prizes.size !== dimension) {
    throw new NativeParseError(FORMAT, 1, `expected ${String(dimension)} prize rows, found ${String(prizes.size)}`);
  }
  if (type === "COP") {
    const declared = wholeOf(required(header, "SETS"), 1, "SETS");
    if (sets.length !== declared) {
      throw new NativeParseError(FORMAT, 1, `expected ${String(declared)} sets, found ${String(sets.length)}`);
    }
  }
  const clustersOf = (node: number): string | null => {
    const ids = sets.filter((set) => set.members.includes(node)).map((set) => String(set.id));

    return ids.length === 0 ? null : ids.join(",");
  };
  const nodes: NativeRow[] = Array.from({ length: dimension }, (_, index) => {
    const id = index + 1;
    const position = coords.get(id);
    const prize = prizes.get(id);
    const lat = geographic && position !== undefined ? degrees(position.x, position.line) : null;
    const lon = geographic && position !== undefined ? degrees(position.y, position.line) : null;

    return {
      id: String(id),
      x: geographic ? null : (position?.x ?? null),
      y: geographic ? null : (position?.y ?? null),
      lat,
      lon,
      prize: prize?.prize ?? null,
      probability: prize?.probability ?? null,
      clusters: clustersOf(id),
    };
  });
  const total = header.get("TPRIZE");

  return {
    meta: {
      name: header.get("NAME") ?? null,
      type,
      budget,
      edgeWeightType: weightType,
      totalPrize: total === undefined ? null : numberOf(total, 1, "TPRIZE"),
      setPrizes: type === "COP" ? sets.map((set) => `${String(set.id)}:${String(set.prize)}`).join(",") : null,
    },
    nodes,
  };
}
