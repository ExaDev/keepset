import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCrosswalk } from "twindex";
import { describe, expect, it } from "vitest";
import { createCatalogue } from "../../src/catalogue";
import { fetchEntry, roundTripEntry } from "../../src/node/fetch-dataset";
import { fixtureManifest } from "../../src/test-support/entries";
import { convertItem, convertSurvey, MAX_ROWS, wholeTableUrl } from "./convert-or";
import { CurationItemSchema, SurveySourceSchema, TARGET_FIELD_NAMES, TARGET_FIELDS } from "./or-survey";

const survey = SurveySourceSchema.parse({
  survey: "a survey",
  surveyed: "2026-07-23",
  entries: [
    { id: "or-10", title: "Service requests", url: "https://example.org/requests", theme: "case lifecycle records: permits, inspections, prosecutions & enforcement", fields: ["location", "lifecycle"] },
    { id: "or-2", title: "Classic instances", url: "https://example.org/instances", theme: "selection + prize + travel — orienteering family", fields: ["prize", "location"] },
  ],
});

/** The file's header cells as it writes them: the parser names the last one Private_note and the one called id column_8, since id is the row's id. */
const header = ["request_id", "status", "latitude", "longitude", "minutes", "district", "Private note", "id"];
const fetchable = {
  status: "fetchable",
  encoding: "utf-8",
  delimiter: "comma",
  skipLines: 0,
  idColumn: "request_id",
  numericColumns: [
    { column: "latitude", factor: 1 },
    { column: "longitude", factor: 1 },
    { column: "minutes", factor: 60 },
  ],
  header,
  map: { status: "status", lat: "latitude", lon: "longitude", duration: "minutes", territory: "district" },
};
const curation = {
  probedOn: "2026-10-19",
  items: [
    { surveyId: "or-10", id: "example-service-requests", namespace: "example", name: "Service requests", description: "Requests raised with a city.", licence: { kind: "spdx", id: "CC-BY-4.0" }, downloadUrl: "https://example.org/requests.csv", flags: ["personal data in one column, not mapped"], outcome: fetchable },
    { surveyId: "or-2", id: "classic-instances", namespace: "example", name: "Classic instances", licence: { kind: "unrecorded" }, flags: [], outcome: { status: "not-fetchable", reason: "the instances are in a text format with no parser yet" } },
  ],
};

const none: ReadonlySet<string> = new Set();

/** The curation with the first item's fetchable outcome changed by a patch. */
function withFirst(patch: Readonly<Record<string, unknown>>): unknown {
  return { ...curation, items: [{ ...curation.items[0], outcome: { ...fetchable, ...patch } }, curation.items[1]] };
}

/** The message of the error converting a curation raises. */
function problem(document: unknown, taken: ReadonlySet<string> = none): string {
  try {
    convertSurvey(survey, document, taken);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the conversion to fail");
}

describe("convertSurvey", () => {
  const { entries, report } = convertSurvey(survey, curation, none);
  const requests = entries.find((entry) => entry.id === "example-service-requests");
  const instances = entries.find((entry) => entry.id === "classic-instances");

  it("makes an entry for every surveyed item, in id order, and reports each once in survey order", () => {
    expect(entries.map((entry) => entry.id)).toEqual(["classic-instances", "example-service-requests"]);
    expect(report.outcomes.map((outcome) => outcome.surveyId)).toEqual(["or-2", "or-10"]);
    expect(report.source).toEqual({ survey: "a survey", surveyed: "2026-07-23", probedOn: "2026-10-19" });
  });

  it("describes a fetchable item from the survey and its curation: namespace, alias, domain, tags, sources, licence and recipe", () => {
    expect(requests).toMatchObject({
      namespace: ["example"],
      aliases: ["service-requests"],
      domain: "Case records",
      tags: ["location", "lifecycle"],
      category: "or/v1",
      licence: { kind: "spdx", id: "CC-BY-4.0" },
      properties: { surveyId: "or-10" },
      expectedCounts: {},
      sources: [
        { url: "https://example.org/requests", retrieved: "2026-10-19", status: "live" },
        { url: "https://example.org/requests.csv", retrieved: "2026-10-19", status: "live" },
      ],
      recipe: { status: "fetchable", source: 1, archive: { kind: "none" }, parser: { format: "csv-table", idColumn: "request_id", delimiter: "comma" } },
    });
  });

  it("records a source's own node count as the entry's expected count, and none when the curation gives none", () => {
    const counted = convertSurvey(survey, withFirst({ expectedNodes: 7 }), none).entries.find((entry) => entry.id === "example-service-requests");
    expect(counted?.expectedCounts).toEqual({ nodes: 7 });
    expect(requests?.expectedCounts).toEqual({});
  });

  it("builds a crosswalk that moves meta, ids and each mapped column, and a parser that keeps only the mapped columns", () => {
    expect(requests?.crosswalk).toEqual({
      source: "csv-table",
      target: "or/v1",
      rules: [
        { op: "move", from: "meta", to: "meta" },
        { op: "move", from: "nodes[].id", to: "nodes[].id" },
        { op: "move", from: "nodes[].minutes", to: "nodes[].duration" },
        { op: "move", from: "nodes[].latitude", to: "nodes[].lat" },
        { op: "move", from: "nodes[].longitude", to: "nodes[].lon" },
        { op: "move", from: "nodes[].status", to: "nodes[].status" },
        { op: "move", from: "nodes[].district", to: "nodes[].territory" },
      ],
      oneWay: [],
    });
    expect(requests?.recipe).toMatchObject({ parser: { columns: ["minutes", "latitude", "longitude", "status", "district"] } });
  });

  it("gives an item with no recipe the not-fetchable reason, one source and the shared nodes crosswalk, and no alias when its id does not start with its namespace", () => {
    expect(instances).toMatchObject({ recipe: { status: "not-fetchable", reason: "the instances are in a text format with no parser yet" }, crosswalk: { file: "crosswalks/or-v1/nodes.json" }, domain: "Orienteering" });
    expect(instances?.sources).toHaveLength(1);
    expect(instances?.aliases).toBeUndefined();
    expect(report.outcomes[0]).toEqual({ surveyId: "or-2", id: "classic-instances", recipe: "not-fetchable", reason: "the instances are in a text format with no parser yet", flags: [] });
    expect(report.outcomes[1]).toEqual({ surveyId: "or-10", id: "example-service-requests", recipe: "fetchable", flags: ["personal data in one column, not mapped"] });
  });

  it("builds a fetchable entry that fetches, maps only the mapped columns, and holds the round trip", async () => {
    const nodes = parseCrosswalk(JSON.parse(readFileSync(join(import.meta.dirname, "../../catalogue/crosswalks/or-v1/nodes.json"), "utf8")));
    const dataset = createCatalogue({ manifest: fixtureManifest, crosswalks: { "crosswalks/or-v1/nodes.json": nodes }, entries }).getDataset("example-service-requests");
    const port = async (): Promise<Response> => Promise.resolve(new Response("request_id,status,latitude,longitude,minutes,district,Private note,id\nr1,Open,51.5,-0.1,2,Camden,secret,x1\nr2,Closed,,,,,,\n"));
    const fetched = await fetchEntry(dataset, { fetch: port });
    expect(fetched.data).toEqual({
      meta: { id: "example-service-requests", name: "Service requests", surveyId: "or-10" },
      nodes: [
        { id: "r1", status: "Open", lat: 51.5, lon: -0.1, duration: 120, territory: "Camden" },
        { id: "r2", status: "Closed", lat: null, lon: null, duration: null, territory: null },
      ],
    });
    expect(JSON.stringify(fetched.data)).not.toContain("secret");
    expect(await roundTripEntry(dataset, { fetch: port })).toMatchObject({ holds: true });
  });
});

describe("convertSurvey refuses an inconsistent curation", () => {
  const [requests, instances] = curation.items;

  it("an item with no curation, a curation for no surveyed item, and a surveyed item curated twice", () => {
    expect(problem({ ...curation, items: curation.items.slice(1) })).toMatch(/or-10 has no curation/);
    expect(problem({ ...curation, items: [...curation.items, { ...instances, surveyId: "or-99", id: "other" }] })).toMatch(/names or-99, which the survey does not have/);
    expect(problem({ ...curation, items: [...curation.items, requests] })).toMatch(/or-10 has more than one curation/);
  });

  it("entry ids that clash within the curation or with an entry another import holds", () => {
    expect(problem({ ...curation, items: [requests, { ...instances, id: "example-service-requests" }] })).toMatch(/the entry id example-service-requests is already the id of or-2/);
    expect(problem(curation, new Set(["classic-instances"]))).toMatch(/classic-instances is already an entry of another source/);
  });

  it("a theme that matches no domain label", () => {
    const odd = SurveySourceSchema.parse({ ...survey, entries: [{ ...survey.entries[1], theme: "something else entirely" }] });
    expect(() => convertSurvey(odd, { probedOn: "2026-10-19", items: [instances] }, none)).toThrow(/matches 0 domain labels/);
  });

  it("a table too long to read, and one exactly at the limit", () => {
    expect(problem(withFirst({ rowCount: MAX_ROWS + 1 }))).toMatch(new RegExp(`${String(MAX_ROWS + 1)} rows, more than ${String(MAX_ROWS)}`));
    expect(() => convertSurvey(survey, withFirst({ rowCount: MAX_ROWS }), none)).not.toThrow();
  });

  it("a header whose cells get the same name, an id column the header does not have, a mapping to a missing column, one column filling two fields, and an empty map", () => {
    expect(problem(withFirst({ header: [...header, "status "] }))).toMatch(/both become the column status/);
    expect(problem(withFirst({ idColumn: "nope" }))).toMatch(/id column nope is not one of the parser's column names/);
    expect(problem(withFirst({ map: { ...fetchable.map, skill: "nowhere" } }))).toMatch(/skill maps the column nowhere/);
    expect(problem(withFirst({ map: { ...fetchable.map, skill: "status" } }))).toMatch(/the column status fills more than one field/);
    expect(problem(withFirst({ map: {} }))).toMatch(/fills no field/);
  });

  it("a number field on a column that is not numeric, a text field on one that is, and a factor on a field that takes the source's own number", () => {
    expect(problem(withFirst({ map: { ...fetchable.map, prize: "district" } }))).toMatch(/prize is a number but district is not declared numeric/);
    expect(problem(withFirst({ numericColumns: [...fetchable.numericColumns, { column: "Private_note", factor: 1 }], map: { ...fetchable.map, skill: "Private_note" } }))).toMatch(/skill is text but Private_note is declared numeric/);
    expect(problem(withFirst({ numericColumns: [{ column: "latitude", factor: 2 }, ...fetchable.numericColumns.slice(1)] }))).toMatch(/lat takes the source's own number, but latitude has the factor 2/);
  });

  it("a numeric column that fills no field or is not in the table", () => {
    expect(problem(withFirst({ numericColumns: [...fetchable.numericColumns, { column: "Private_note", factor: 1 }] }))).toMatch(/Private_note is declared numeric but fills no field/);
    expect(problem(withFirst({ numericColumns: [...fetchable.numericColumns, { column: "elsewhere", factor: 1 }] }))).toMatch(/numericColumns names elsewhere/);
  });

  it("prose with a dash as punctuation", () => {
    expect(() => convertSurvey(survey, { ...curation, items: [{ ...requests, name: "A \u2014 B" }, instances] }, none)).toThrow(/must not use a dash/);
  });
});

describe("the survey's themes and the target fields", () => {
  const real = SurveySourceSchema.parse(JSON.parse(readFileSync(join(import.meta.dirname, "sources/or-datasets-survey.json"), "utf8")));

  it("every theme of the committed survey files under exactly one domain label", () => {
    for (const item of real.entries) {
      const only = { probedOn: "2026-10-19", items: [{ surveyId: item.id, id: "x", namespace: "x", name: "x", licence: { kind: "unrecorded" }, flags: [], outcome: { status: "not-fetchable", reason: "x" } }] };
      expect(() => convertSurvey({ ...real, entries: [item] }, only, none), item.id).not.toThrow();
    }
  });

  it("lists the target fields in code-unit order, with a kind for each", () => {
    expect([...TARGET_FIELD_NAMES]).toEqual([...TARGET_FIELD_NAMES].sort());
    expect(Object.keys(TARGET_FIELDS).sort()).toEqual([...TARGET_FIELD_NAMES]);
  });
});

describe("wholeTableUrl", () => {
  it("asks a Socrata resource endpoint for as many rows as a recipe may read", () => {
    expect(wholeTableUrl("https://data.example.org/resource/abcd-1234.csv")).toBe(`https://data.example.org/resource/abcd-1234.csv?%24limit=${String(MAX_ROWS)}`);
  });

  it("keeps a limit the URL already sets", () => {
    const url = "https://data.example.org/resource/abcd-1234.csv?$limit=50";
    expect(wholeTableUrl(url)).toBe(url);
  });

  it("leaves every other URL as it is", () => {
    for (const url of ["https://data.example.org/api/views/abcd-1234/rows.csv?accessType=DOWNLOAD", "https://data.example.org/dataset/x/resource/0a1b2c3d/download/x.csv", "https://data.example.org/resource/abcd-1234.json"]) {
      expect(wholeTableUrl(url)).toBe(url);
    }
  });
});

describe("convertItem for a paged ArcGIS layer", () => {
  const [item] = survey.entries;
  const layer = "https://example.org/arcgis/rest/services/Violations/FeatureServer/0";
  const arcgis = {
    status: "fetchable-arcgis",
    orderBy: "OBJECTID",
    point: true,
    idColumn: "OBJECTID",
    numericColumns: [
      { column: "geometry_latitude", factor: 1 },
      { column: "geometry_longitude", factor: 1 },
      { column: "FINE", factor: 1 },
    ],
    dateColumns: ["OPENED", "UNMAPPED_DATE"],
    header: ["OBJECTID", "FINE", "OPENED", "UNMAPPED_DATE", "KIND", "OWNER"],
    map: { lat: "geometry_latitude", lon: "geometry_longitude", prize: "FINE", opened: "OPENED", skill: "KIND" },
  };
  const curated = (outcome: Record<string, unknown>, downloadUrl: string | null = layer): Parameters<typeof convertItem>[1] =>
    CurationItemSchema.parse({ surveyId: "or-10", id: "example-violations", namespace: "example", name: "Violations", licence: { kind: "unrecorded" }, ...(downloadUrl === null ? {} : { downloadUrl }), flags: [], outcome });
  const failure = (outcome: Record<string, unknown>, downloadUrl: string | null = layer): string => {
    try {
      convertItem(item ?? expect.unreachable("the fixture survey has an item"), curated(outcome, downloadUrl), "2026-10-19");
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error("expected the conversion to fail");
  };

  it("makes a paged geojson recipe that keeps only the mapped columns, and a crosswalk that moves each onto its field", () => {
    const { entry } = convertItem(item ?? expect.unreachable("the fixture survey has an item"), curated(arcgis), "2026-10-19");
    expect(entry.sources.map((source) => source.url)).toEqual(["https://example.org/requests", layer]);
    expect(entry.recipe).toEqual({
      status: "fetchable",
      source: 1,
      paging: { kind: "arcgis-query", orderBy: "OBJECTID" },
      archive: { kind: "none" },
      parser: {
        format: "geojson",
        encoding: "utf-8",
        idColumn: "OBJECTID",
        numericColumns: arcgis.numericColumns,
        dateColumns: ["OPENED"],
        columns: ["geometry_latitude", "geometry_longitude", "OPENED", "FINE", "KIND"],
      },
    });
    expect(entry.crosswalk).toMatchObject({ source: "geojson", target: "or/v1", oneWay: [] });
  });

  it("refuses a layer with no URL, a date written onto a number field, a date column the layer lacks, and a property named like a point column", () => {
    expect(failure(arcgis, null)).toMatch(/needs the layer's URL as the downloadUrl/);
    expect(failure({ ...arcgis, map: { lat: "geometry_latitude", lon: "geometry_longitude", skill: "KIND", prize: "OPENED" }, numericColumns: arcgis.numericColumns.filter((numeric) => numeric.column !== "FINE") })).toMatch(/prize is a number but OPENED is a date/);
    expect(failure({ ...arcgis, dateColumns: ["MISSING"] })).toMatch(/dateColumns names MISSING/);
    expect(failure({ ...arcgis, header: [...arcgis.header, "geometry_latitude"] })).toMatch(/two columns have the same name/);
  });
});
