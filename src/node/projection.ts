import { ArchiveError } from "../errors";

/** One node of a well-known text (WKT) coordinate system definition: its keyword and its arguments, each a quoted text, a number or a nested node. */
export interface WktNode {
  readonly keyword: string;
  readonly values: readonly (string | number | WktNode)[];
}

/** A function from a coordinate system's planar or angular pair to WGS84 longitude and latitude in degrees. */
export type ToWgs84 = (x: number, y: number) => { readonly longitude: number; readonly latitude: number };

const HALF_TURN_DEGREES = 180;
const DEGREES_PER_RADIAN = HALF_TURN_DEGREES / Math.PI;
/** An eighth of a turn, the angle from which `t` (Snyder 15-9) takes half the latitude. */
const EIGHTH_TURN = Math.PI / (2 * 2);
/** How close, in radians, two successive estimates of the latitude must be for the inverse projection to stop: far below a millimetre on the ground. */
const LATITUDE_TOLERANCE = 1e-12;
/** The most refinements the latitude takes; the series converges in a handful for any point a conic projection covers, so reaching this means the input is not a point the projection maps. */
const LATITUDE_ITERATIONS = 32;
/** The relative tolerance within which a unit's stated factor must equal the one keepset reads: a degree in radians, or the metre. */
const UNIT_TOLERANCE = 1e-12;
const DEGREE_IN_RADIANS = Math.PI / HALF_TURN_DEGREES;

/**
 * The geodetic datums whose coordinates keepset takes as WGS84 without a shift: WGS84 itself, and ETRS89 and RGF93 (France's realisation of ETRS89), which were defined to coincide with WGS84 and have drifted from it by under a metre, below the precision of the geocoded addresses such data carries. Any other datum needs a transformation keepset does not make, so a coordinate system on it is refused. Names are compared without case, spaces or underscores, and both the ESRI spelling (`D_RGF_1993`) and the EPSG one (`Reseau_Geodesique_Francais_1993`) are listed.
 */
const WGS84_COINCIDENT_DATUMS: ReadonlySet<string> = new Set(["dwgs1984", "wgs1984", "worldgeodeticsystem1984", "drgf1993", "reseaugeodesiquefrancais1993", "detrs1989", "europeanterrestrialreferencesystem1989"]);

/**
 * Parses well-known text into its tree.
 * @param text - A `.prj` file's text.
 * @returns The root node.
 * @throws ArchiveError when the text is not well-formed WKT.
 */
export function parseWkt(text: string): WktNode {
  const tokenPattern = /\s*("(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_]*|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|[[\](),])\s*/y;
  const tokens: string[] = [];
  while (tokenPattern.lastIndex < text.length) {
    const at = tokenPattern.lastIndex;
    const match = tokenPattern.exec(text);
    if (match?.[1] === undefined) {
      throw new ArchiveError(`the .prj is not well-known text: it has ${JSON.stringify(text.slice(at).trimStart().slice(0, 1))} where a keyword, text, number or bracket should be`);
    }
    tokens.push(match[1]);
  }
  let position = 0;
  const node = (): WktNode => {
    const keyword = tokens[position];
    if (keyword === undefined || !/^[A-Za-z_]/.test(keyword) || !["[", "("].includes(tokens[position + 1] ?? "")) {
      throw new ArchiveError(`the .prj is not well-known text: expected a keyword and a bracket at token ${String(position + 1)}`);
    }
    position += 2;
    const values: (string | number | WktNode)[] = [];
    for (;;) {
      const token = tokens[position];
      if (token === undefined) {
        throw new ArchiveError(`the .prj is not well-known text: ${keyword} is not closed`);
      }
      if (token.startsWith('"')) {
        values.push(token.slice(1, -1).replaceAll('""', '"'));
        position += 1;
      } else if (/^[-+.\d]/.test(token)) {
        values.push(Number(token));
        position += 1;
      } else {
        values.push(node());
      }
      const separator = tokens[position];
      position += 1;
      if (separator === "]" || separator === ")") {
        return { keyword: keyword.toUpperCase(), values };
      }
      if (separator !== ",") {
        throw new ArchiveError(`the .prj is not well-known text: expected a comma or a closing bracket in ${keyword}`);
      }
    }
  };
  const root = node();
  if (position !== tokens.length) {
    throw new ArchiveError("the .prj is not well-known text: it continues after its definition");
  }

  return root;
}

/**
 * The child nodes of a node with a keyword.
 * @param node - The parent.
 * @param keyword - The keyword, upper case.
 * @returns The children with that keyword, in order.
 */
function children(node: WktNode, keyword: string): WktNode[] {
  return node.values.filter((value): value is WktNode => typeof value === "object" && value.keyword === keyword);
}

/**
 * The one child node of a node with a keyword.
 * @param node - The parent.
 * @param keyword - The keyword, upper case.
 * @returns The child.
 * @throws ArchiveError when there is not exactly one.
 */
function child(node: WktNode, keyword: string): WktNode {
  const found = children(node, keyword);
  const [only] = found;
  if (only === undefined || found.length !== 1) {
    throw new ArchiveError(`the .prj's ${node.keyword} has ${String(found.length)} ${keyword} definitions, not one`);
  }

  return only;
}

/**
 * The number a node gives at a position.
 * @param node - The node.
 * @param index - The position of the number among its values.
 * @returns The number.
 * @throws ArchiveError when the value there is not a number.
 */
function numberAt(node: WktNode, index: number): number {
  const value = node.values[index];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ArchiveError(`the .prj's ${node.keyword} has no number at position ${String(index + 1)}`);
  }

  return value;
}

/**
 * The text a node names itself by, its first value.
 * @param node - The node.
 * @returns The name.
 * @throws ArchiveError when the node does not start with a name.
 */
function nameOf(node: WktNode): string {
  const [name] = node.values;
  if (typeof name !== "string") {
    throw new ArchiveError(`the .prj's ${node.keyword} has no name`);
  }

  return name;
}

/**
 * A name compared without case, spaces or underscores.
 * @param name - The name.
 * @returns Its comparison key.
 */
const keyOf = (name: string): string => name.toLowerCase().replaceAll(/[\s_]+/g, "");

/**
 * Checks that a factor is the one expected within a relative tolerance.
 * @param factor - The stated factor.
 * @param expected - The factor keepset reads.
 * @returns Whether they agree.
 */
const agrees = (factor: number, expected: number): boolean => Math.abs(factor - expected) <= UNIT_TOLERANCE * expected;

/**
 * Reads a geographic coordinate system: its datum must coincide with WGS84, its prime meridian must be Greenwich and its angular unit the degree.
 * @param geogcs - The `GEOGCS` node.
 * @returns The ellipsoid's semi-major axis in metres and its inverse flattening.
 * @throws ArchiveError naming what is not read.
 */
function readGeographic(geogcs: WktNode): { readonly semiMajorAxis: number; readonly inverseFlattening: number } {
  const datum = child(geogcs, "DATUM");
  if (!WGS84_COINCIDENT_DATUMS.has(keyOf(nameOf(datum)))) {
    throw new ArchiveError(`the .prj's datum is ${nameOf(datum)}, which needs a transformation to WGS84 that keepset does not make`);
  }
  const primeMeridian = numberAt(child(geogcs, "PRIMEM"), 1);
  if (primeMeridian !== 0) {
    throw new ArchiveError(`the .prj's prime meridian is ${String(primeMeridian)} degrees from Greenwich, which keepset does not read`);
  }
  const unit = numberAt(child(geogcs, "UNIT"), 1);
  if (!agrees(unit, DEGREE_IN_RADIANS)) {
    throw new ArchiveError(`the .prj's angular unit is ${String(unit)} radians, not the degree`);
  }
  const spheroid = child(datum, "SPHEROID");

  return { semiMajorAxis: numberAt(spheroid, 1), inverseFlattening: numberAt(spheroid, 2) };
}

/** The parameters of a Lambert conformal conic projection with two standard parallels, angles in radians and distances in metres. */
interface LambertConformalConic {
  readonly semiMajorAxis: number;
  readonly inverseFlattening: number;
  readonly falseEasting: number;
  readonly falseNorthing: number;
  readonly centralMeridian: number;
  readonly latitudeOfOrigin: number;
  readonly standardParallel1: number;
  readonly standardParallel2: number;
  readonly scaleFactor: number;
}

/**
 * The inverse of the ellipsoidal Lambert conformal conic projection (Snyder, Map Projections: A Working Manual, USGS Professional Paper 1395, 1987, equations 15-1 to 15-11 and 7-9), which takes projected metres back to geodetic longitude and latitude.
 * @param projection - The projection's parameters.
 * @returns The inverse, which gives degrees.
 * @throws ArchiveError, when the returned function is called, for a point whose latitude does not converge.
 */
export function inverseLambertConformalConic(projection: LambertConformalConic): ToWgs84 {
  const flattening = 1 / projection.inverseFlattening;
  const eccentricity = Math.sqrt(2 * flattening - flattening * flattening);
  const m = (latitude: number): number => Math.cos(latitude) / Math.sqrt(1 - (eccentricity * Math.sin(latitude)) ** 2);
  const t = (latitude: number): number => Math.tan(EIGHTH_TURN - latitude / 2) / ((1 - eccentricity * Math.sin(latitude)) / (1 + eccentricity * Math.sin(latitude))) ** (eccentricity / 2);
  const { standardParallel1: phi1, standardParallel2: phi2 } = projection;
  const n = phi1 === phi2 ? Math.sin(phi1) : (Math.log(m(phi1)) - Math.log(m(phi2))) / (Math.log(t(phi1)) - Math.log(t(phi2)));
  const scaledF = (projection.scaleFactor * m(phi1)) / (n * t(phi1) ** n);
  const rho0 = projection.semiMajorAxis * scaledF * t(projection.latitudeOfOrigin) ** n;
  const sign = Math.sign(n);

  return (x, y) => {
    const easting = x - projection.falseEasting;
    const northing = rho0 - (y - projection.falseNorthing);
    const rho = sign * Math.hypot(easting, northing);
    const theta = Math.atan2(sign * easting, sign * northing);
    const tOfPoint = (rho / (projection.semiMajorAxis * scaledF)) ** (1 / n);
    let latitude = Math.PI / 2 - 2 * Math.atan(tOfPoint);
    for (let iteration = 0; iteration < LATITUDE_ITERATIONS; iteration += 1) {
      const sine = eccentricity * Math.sin(latitude);
      const next = Math.PI / 2 - 2 * Math.atan(tOfPoint * ((1 - sine) / (1 + sine)) ** (eccentricity / 2));
      if (Math.abs(next - latitude) < LATITUDE_TOLERANCE) {
        return { longitude: (theta / n + projection.centralMeridian) * DEGREES_PER_RADIAN, latitude: next * DEGREES_PER_RADIAN };
      }
      latitude = next;
    }
    throw new ArchiveError(`the point (${String(x)}, ${String(y)}) is not one the projection maps: its latitude does not converge`);
  };
}

/** The ESRI and OGC names of the Lambert conformal conic projection with two standard parallels, compared as `keyOf` compares them. */
const LAMBERT_CONFORMAL_CONIC = new Set(["lambertconformalconic", "lambertconformalconic2sp"]);

/**
 * Reads a projected coordinate system on a Lambert conformal conic projection.
 * @param projcs - The `PROJCS` node.
 * @returns The inverse projection.
 * @throws ArchiveError naming what is not read.
 */
function readProjected(projcs: WktNode): ToWgs84 {
  const ellipsoid = readGeographic(child(projcs, "GEOGCS"));
  const projection = nameOf(child(projcs, "PROJECTION"));
  if (!LAMBERT_CONFORMAL_CONIC.has(keyOf(projection))) {
    throw new ArchiveError(`the .prj's projection is ${projection}, which keepset does not invert (it reads the Lambert conformal conic with two standard parallels)`);
  }
  const metresPerUnit = numberAt(child(projcs, "UNIT"), 1);
  if (!agrees(metresPerUnit, 1)) {
    throw new ArchiveError(`the .prj's linear unit is ${String(metresPerUnit)} metres, not the metre`);
  }
  const parameters = new Map(children(projcs, "PARAMETER").map((parameter) => [keyOf(nameOf(parameter)), numberAt(parameter, 1)]));
  const parameter = (name: string, absent?: number): number => {
    const value = parameters.get(keyOf(name)) ?? absent;
    if (value === undefined) {
      throw new ArchiveError(`the .prj's projection has no ${name} parameter`);
    }

    return value;
  };
  const known = new Set(["False_Easting", "False_Northing", "Central_Meridian", "Standard_Parallel_1", "Standard_Parallel_2", "Latitude_Of_Origin", "Scale_Factor"].map(keyOf));
  const unknown = [...parameters.keys()].filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new ArchiveError(`the .prj's projection has parameters keepset does not read: ${unknown.join(", ")}`);
  }

  return inverseLambertConformalConic({
    ...ellipsoid,
    falseEasting: parameter("False_Easting"),
    falseNorthing: parameter("False_Northing"),
    centralMeridian: parameter("Central_Meridian") * DEGREE_IN_RADIANS,
    latitudeOfOrigin: parameter("Latitude_Of_Origin") * DEGREE_IN_RADIANS,
    standardParallel1: parameter("Standard_Parallel_1") * DEGREE_IN_RADIANS,
    standardParallel2: parameter("Standard_Parallel_2") * DEGREE_IN_RADIANS,
    scaleFactor: parameter("Scale_Factor", 1),
  });
}

/**
 * The conversion a shapefile's `.prj` states from its coordinates to WGS84 longitude and latitude in degrees. A geographic system on a datum that coincides with WGS84 is read as it is; a projected one must use the Lambert conformal conic projection with two standard parallels in metres on such a datum. Every other system is refused, so a position is never given in the wrong place.
 * @param text - The `.prj` file's text.
 * @returns The conversion.
 * @throws ArchiveError naming the part of the definition keepset does not read.
 */
export function toWgs84Of(text: string): ToWgs84 {
  const root = parseWkt(text);
  if (root.keyword === "GEOGCS") {
    readGeographic(root);

    return (x, y) => ({ longitude: x, latitude: y });
  }
  if (root.keyword === "PROJCS") {
    return readProjected(root);
  }
  throw new ArchiveError(`the .prj defines a ${root.keyword}, not a GEOGCS or a PROJCS`);
}
