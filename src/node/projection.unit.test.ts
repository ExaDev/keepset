import { describe, expect, it } from "vitest";
import { ArchiveError } from "../errors";
import { parseWkt, toWgs84Of } from "./projection";

/** The `.prj` of the Sitadel housing permits shapefile, as published: RGF93 Lambert-93 in ESRI's spelling. */
const LAMBERT_93 =
  'PROJCS["RGF_1993_Lambert_93",GEOGCS["GCS_RGF_1993",DATUM["D_RGF_1993",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Lambert_Conformal_Conic"],PARAMETER["False_Easting",700000.0],PARAMETER["False_Northing",6600000.0],PARAMETER["Central_Meridian",3.0],PARAMETER["Standard_Parallel_1",49.0],PARAMETER["Standard_Parallel_2",44.0],PARAMETER["Latitude_Of_Origin",46.5],UNIT["Meter",1.0]]';

/** A geographic system on WGS84, as ESRI writes it. */
const WGS84 = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';

/** Points of the Sitadel shapefile (its first record and its bounding box's corners) and their RGF93 longitude and latitude as PROJ 9.8.1 gives them (pyproj, EPSG:2154 to EPSG:4171). */
const REFERENCE = [
  { x: 696_476.697_469_719_7, y: 6_872_370.315_696_111, longitude: 2.951_894, latitude: 48.951_285 },
  { x: 586_812.607_351_165_1, y: 6_780_986.555_083_597, longitude: 1.478_805_139_983_760_3, latitude: 48.119_436_655_482_28 },
  { x: 738_533.716_142_206_7, y: 6_904_902.064_637_025, longitude: 3.529_094_977_180_453, latitude: 49.242_632_369_271_72 },
  { x: 1_000_000, y: 6_000_000, longitude: 6.556_805_372_533_343_5, latitude: 41.041_963_103_600_49 },
] as const;
/** Decimal places the converted degrees must agree to: a hundred-millionth of a degree is about a millimetre. */
const DEGREE_DIGITS = 8;
/** Lambert-93's false origin, in metres, and the point it stands for: its central meridian and latitude of origin. */
const FALSE_ORIGIN = { x: 700_000, y: 6_600_000 } as const;
const PROJECTION_ORIGIN = { longitude: 3, latitude: 46.5 } as const;
/** A position in degrees, which a geographic system passes through unchanged. */
const LONDON = { longitude: -0.1275, latitude: 51.507_222 } as const;
/** The number `-1.5e2` stands for. */
const SCIENTIFIC = -150;

describe("toWgs84Of", () => {
  it("inverts Lambert-93 to the longitude and latitude PROJ gives, and maps the false origin to the projection's origin", () => {
    const toWgs84 = toWgs84Of(LAMBERT_93);
    for (const point of REFERENCE) {
      const converted = toWgs84(point.x, point.y);
      expect(converted.longitude).toBeCloseTo(point.longitude, DEGREE_DIGITS);
      expect(converted.latitude).toBeCloseTo(point.latitude, DEGREE_DIGITS);
    }
    const origin = toWgs84(FALSE_ORIGIN.x, FALSE_ORIGIN.y);
    expect(origin.longitude).toBeCloseTo(PROJECTION_ORIGIN.longitude, DEGREE_DIGITS);
    expect(origin.latitude).toBeCloseTo(PROJECTION_ORIGIN.latitude, DEGREE_DIGITS);
  });

  it("reads the same projection in the EPSG spelling of its datum and with an explicit unit scale factor", () => {
    const epsg = LAMBERT_93.replace("D_RGF_1993", "Reseau_Geodesique_Francais_1993").replace('PARAMETER["Latitude_Of_Origin",46.5]', 'PARAMETER["Latitude_Of_Origin",46.5],PARAMETER["Scale_Factor",1.0]');
    const [first] = REFERENCE;
    expect(toWgs84Of(epsg)(first.x, first.y).latitude).toBeCloseTo(first.latitude, DEGREE_DIGITS);
  });

  it("passes a geographic system on WGS84 through as longitude and latitude", () => {
    expect(toWgs84Of(WGS84)(LONDON.longitude, LONDON.latitude)).toEqual(LONDON);
  });

  it("refuses a datum that needs a shift, another projection, another unit, an unread parameter and a compound system", () => {
    expect(() => toWgs84Of(WGS84.replace("D_WGS_1984", "D_North_American_1927"))).toThrow(/D_North_American_1927, which needs a transformation/);
    expect(() => toWgs84Of(LAMBERT_93.replace('PROJECTION["Lambert_Conformal_Conic"]', 'PROJECTION["Transverse_Mercator"]'))).toThrow(/Transverse_Mercator, which keepset does not invert/);
    expect(() => toWgs84Of(LAMBERT_93.replace('UNIT["Meter",1.0]', 'UNIT["Foot_US",0.3048006096012192]'))).toThrow(/linear unit is 0.3048006096012192 metres/);
    expect(() => toWgs84Of(LAMBERT_93.replace('PARAMETER["False_Easting",700000.0]', 'PARAMETER["False_Easting",700000.0],PARAMETER["Azimuth",10.0]'))).toThrow(/parameters keepset does not read: azimuth/);
    expect(() => toWgs84Of(WGS84.replace('PRIMEM["Greenwich",0.0]', 'PRIMEM["Paris",2.33722917]'))).toThrow(/prime meridian is 2.33722917/);
    expect(() => toWgs84Of(`COMPD_CS["x",${WGS84}]`)).toThrow(/defines a COMPD_CS/);
  });
});

describe("parseWkt", () => {
  it("reads keywords, quoted text with doubled quotes, numbers and nesting, in either bracket style", () => {
    expect(parseWkt('A["say ""hi""", -1.5e2, B(2)]')).toEqual({ keyword: "A", values: ['say "hi"', SCIENTIFIC, { keyword: "B", values: [2] }] });
  });

  it("refuses text that is not well-formed", () => {
    expect(() => parseWkt('A["x",1')).toThrow(ArchiveError);
    expect(() => parseWkt('A["x";1]')).toThrow(/";" where a keyword/);
    expect(() => parseWkt('A["x"] B["y"]')).toThrow(/continues after its definition/);
  });
});
