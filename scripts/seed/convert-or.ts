import { CrosswalkSchema, validateCrosswalk, type Crosswalk } from "twindex";
import { parseEntry, type Entry } from "../../src/entry";
import { columnNames } from "../../src/parsers/csv-table";
import { POINT_COLUMNS } from "../../src/parsers/geojson";
import { CurationSchema, TARGET_FIELD_NAMES, TARGET_FIELDS, type Curation, type CurationItem, type SurveyEntry, type SurveySource, type TableOutcome, type TargetField } from "./or-survey";

/** The shared crosswalk of an entry with no recipe yet: the document's meta and node ids, all that is known of a dataset whose columns have not been read into a mapping. */
export const OR_NODES_CROSSWALK = "crosswalks/or-v1/nodes.json";

/** The most cells (rows times the cells each row keeps, its id included) a table may have to be given a recipe. A fetch holds every kept cell of the table at once, in the parsed rows, the crosswalk's result and the validated document, so memory grows with the cells and not with the file's size; a table of tens of millions of cells is not read by one fetch and is imported without a recipe, saying so. Measured on whole fetches: a table of about five million cells needed a heap of between 512 and 768 MiB, and one of about eleven million cells between 1 and 1.5 GiB, so this stays within Node's usual default heap. */
export const MAX_CELLS = 12_000_000;

/** How many rows a page of a Socrata resource holds. A response is a CSV of every column, so a page is a few tens of megabytes for a table of up to a kilobyte a row, short enough that a response is not cut off in transit and long enough that a table of millions of rows is a few dozen requests. */
export const SOCRATA_PAGE_ROWS = 50_000;

/** The path of a Socrata resource endpoint: a four-by-four dataset id and an output format. */
const SOCRATA_RESOURCE_CSV = /^\/resource\/[a-z0-9]{4}-[a-z0-9]{4}\.csv$/;

/**
 * How a recipe pages a source URL. A Socrata resource endpoint returns a small fixed number of rows unless it is given a limit, and one response of a large table can be cut short in transit, so it is read a page at a time; every other URL is one file.
 * @param url - The URL the survey or the curation gives for the table.
 * @returns The paging of a Socrata resource endpoint with no query, and undefined for any other URL.
 */
export function socrataPaging(url: string): { readonly kind: "socrata-resource"; readonly pageSize: number } | undefined {
  const parsed = new URL(url);

  return SOCRATA_RESOURCE_CSV.test(parsed.pathname) && parsed.search === "" ? { kind: "socrata-resource", pageSize: SOCRATA_PAGE_ROWS } : undefined;
}

/** The short label each survey theme is filed under as the entry's domain, matched against the theme text because the survey's own wording is long and uses dashes. Every theme the survey uses must match exactly one. */
const THEMES: readonly (readonly [RegExp, string])[] = [
  [/permits, inspections, prosecutions/, "Case records"],
  [/technician & home-care routing/, "Technician and home-care routing"],
  [/emergency dispatch/, "Emergency dispatch"],
  [/VRPTW family/, "Vehicle routing with time windows"],
  [/civic & environmental monitoring/, "Civic and environmental monitoring"],
  [/orienteering family/, "Orienteering"],
  [/last-mile logistics/, "Last-mile logistics"],
  [/real-world risk\/outcome proxies/, "Risk and outcome records"],
  [/insurance claims & unclaimed money/, "Claims and unclaimed money"],
  [/generated logs/, "Synthetic logs"],
  [/cash-collection clustering/, "Cash collection"],
];

/** The fields whose values a recipe may scale: durations and travel times are put in seconds, and every other number is the source's own. */
const SCALABLE_FIELDS: ReadonlySet<TargetField> = new Set(["duration", "travelTime"]);

/** How one surveyed dataset was imported. */
export interface OrOutcome {
  readonly surveyId: string;
  readonly id: string;
  readonly recipe: "fetchable" | "not-fetchable";
  readonly reason?: string;
  readonly flags: readonly string[];
}

/** The import's report: where its inputs came from and how every surveyed dataset was imported. */
export interface OrReport {
  readonly source: { readonly survey: string; readonly surveyed: string; readonly probedOn: string };
  readonly outcomes: readonly OrOutcome[];
}

/**
 * The domain a survey theme is filed under.
 * @param item - The surveyed item.
 * @returns The domain label.
 * @throws Error when the theme matches no label, or more than one.
 */
function domainOf(item: SurveyEntry): string {
  const labels = THEMES.filter(([pattern]) => pattern.test(item.theme)).map(([, label]) => label);
  const [label] = labels;
  if (label === undefined || labels.length > 1) {
    throw new Error(`${item.id}: the theme ${JSON.stringify(item.theme)} matches ${String(labels.length)} domain labels, not one`);
  }

  return label;
}

/**
 * The parser's names for a table outcome's columns, and the columns it emits, which are those names without the id column. A table's are derived from its header cells; an ArcGIS layer's are its property names as written, then the position columns of a point layer.
 * @param id - The surveyed item's id, for errors.
 * @param outcome - The outcome.
 * @returns Every name, and the columns of a row other than its id.
 * @throws Error naming the item when two columns get the same name.
 */
function columnsOf(id: string, outcome: TableOutcome): { readonly names: readonly string[]; readonly columns: readonly string[] } {
  try {
    const names = outcome.status === "fetchable" ? columnNames(outcome.header, outcome.idColumn, 1) : [...outcome.header, ...(outcome.point ? [POINT_COLUMNS.latitude, POINT_COLUMNS.longitude] : [])];
    if (new Set(names).size !== names.length) {
      throw new Error("two columns have the same name");
    }

    return { names, columns: names.filter((name) => name !== outcome.idColumn) };
  } catch (error) {
    throw new Error(`${id}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/**
 * Checks a fetchable outcome against the rules that keep a recipe sound: the columns it names exist, a field is filled by one column and a column fills one field, a number field reads a numeric column and a text field does not, only durations and travel times are scaled, and no table too long to read is given a recipe.
 * @param id - The surveyed item's id, for errors.
 * @param outcome - The outcome.
 * @throws Error naming the item and the rule it breaks.
 */
function checkFetchable(id: string, outcome: TableOutcome): void {
  const fail = (message: string): never => {
    throw new Error(`${id}: ${message}`);
  };
  const named = columnsOf(id, outcome);
  if (outcome.idColumn !== null && !named.names.includes(outcome.idColumn)) {
    fail(`the id column ${outcome.idColumn} is not one of the parser's column names for this header`);
  }
  const columns = new Set(named.columns);
  const numeric = new Map(outcome.numericColumns.map((entry) => [entry.column, entry.factor]));
  const used = new Set<string>();
  const mapped = TARGET_FIELD_NAMES.flatMap((field) => {
    const column = outcome.map[field];

    return column === undefined ? [] : [[field, column] as const];
  });
  if (mapped.length === 0) {
    fail("the map fills no field, so a fetch would carry nothing beyond ids");
  }
  const cells = (outcome.rowCount ?? 0) * (mapped.length + 1);
  if (cells > MAX_CELLS) {
    fail(`the table has ${String(outcome.rowCount)} rows of ${String(mapped.length + 1)} kept cells, ${String(cells)} cells, more than ${String(MAX_CELLS)}, so it has no recipe`);
  }
  if (outcome.status === "fetchable-arcgis") {
    for (const column of outcome.dateColumns) {
      if (!columns.has(column)) {
        fail(`dateColumns names ${column}, which the layer does not have`);
      }
      if (numeric.has(column)) {
        fail(`${column} is both a date and numeric`);
      }
      const filled = mapped.find(([, mappedColumn]) => mappedColumn === column);
      if (filled !== undefined && TARGET_FIELDS[filled[0]] === "number") {
        fail(`${filled[0]} is a number but ${column} is a date, written as text`);
      }
    }
  }
  for (const [field, column] of mapped) {
    if (!columns.has(column)) {
      fail(`${field} maps the column ${column}, which the table does not have`);
    }
    if (used.has(column)) {
      fail(`the column ${column} fills more than one field`);
    }
    used.add(column);
    const kind = TARGET_FIELDS[field];
    const factor = numeric.get(column);
    if (kind === "number" && factor === undefined) {
      fail(`${field} is a number but ${column} is not declared numeric`);
    }
    if (kind === "text" && factor !== undefined) {
      fail(`${field} is text but ${column} is declared numeric`);
    }
    if (factor !== undefined && factor !== 1 && !SCALABLE_FIELDS.has(field)) {
      fail(`${field} takes the source's own number, but ${column} has the factor ${String(factor)}`);
    }
  }
  for (const column of numeric.keys()) {
    if (!columns.has(column)) {
      fail(`numericColumns names ${column}, which the table does not have`);
    }
    if (!used.has(column)) {
      fail(`${column} is declared numeric but fills no field, so a stray cell would fail a fetch for nothing`);
    }
  }
}

/**
 * The crosswalk of a fetchable outcome: the document's meta and node ids and each mapped column onto its field. The recipe's parser keeps only the mapped columns, so there is nothing left to drop and the round trip holds.
 * @param outcome - The outcome.
 * @returns The crosswalk document.
 * @throws Error when twindex finds the crosswalk structurally invalid.
 */
function crosswalkOf(outcome: TableOutcome): Crosswalk {
  const crosswalk = {
    source: outcome.status === "fetchable" ? "csv-table" : "geojson",
    target: "or/v1",
    rules: [
      { op: "move", from: "meta", to: "meta" },
      { op: "move", from: "nodes[].id", to: "nodes[].id" },
      ...TARGET_FIELD_NAMES.flatMap((field) => {
        const column = outcome.map[field];

        return column === undefined ? [] : [{ op: "move", from: `nodes[].${column}`, to: `nodes[].${field}` }];
      }),
    ],
  };
  const parsed = CrosswalkSchema.parse(crosswalk);
  const issues = validateCrosswalk(parsed);
  if (issues.length > 0) {
    throw new Error(`the crosswalk is invalid: ${issues.map((issue) => issue.message).join("; ")}`);
  }

  return parsed;
}

/** The columns a recipe's parser keeps: those a field is mapped from, in the order of the fields. */
const keptColumns = (outcome: TableOutcome): string[] => TARGET_FIELD_NAMES.flatMap((field) => outcome.map[field] ?? []);

/**
 * The recipe of an outcome.
 * @param outcome - The outcome.
 * @param source - The index of the entry's source the recipe reads.
 * @param url - The URL of that source.
 * @returns The recipe, fetchable or not.
 */
function recipeOf(outcome: CurationItem["outcome"], source: number, url: string): unknown {
  if (outcome.status === "not-fetchable") {
    return { status: "not-fetchable", reason: outcome.reason };
  }
  if (outcome.status === "fetchable-arcgis") {
    const kept = new Set(keptColumns(outcome));

    return {
      status: "fetchable",
      source,
      paging: { kind: "arcgis-query", orderBy: outcome.orderBy },
      archive: { kind: "none" },
      parser: { format: "geojson", encoding: "utf-8", idColumn: outcome.idColumn, numericColumns: outcome.numericColumns, dateColumns: outcome.dateColumns.filter((column) => kept.has(column)), columns: [...kept] },
    };
  }

  const paging = socrataPaging(url);

  return {
    status: "fetchable",
    source,
    ...(paging === undefined ? {} : { paging }),
    archive: outcome.sheet === undefined ? { kind: "none" } : { kind: "xlsx", sheet: outcome.sheet },
    parser: { format: "csv-table", encoding: outcome.encoding, delimiter: outcome.delimiter, skipLines: outcome.skipLines, idColumn: outcome.idColumn, numericColumns: outcome.numericColumns, columns: keptColumns(outcome) },
  };
}

/**
 * Builds the entry and the outcome for one surveyed dataset.
 * @param item - The surveyed item.
 * @param curation - Its curation.
 * @param probedOn - The date the curation's facts were read.
 * @returns The entry and how it was imported.
 * @throws Error naming the item and the problem when the curation does not make a sound entry.
 */
export function convertItem(item: SurveyEntry, curation: CurationItem, probedOn: string): { readonly entry: Entry; readonly outcome: OrOutcome } {
  const { outcome } = curation;
  const givenUrl = curation.downloadUrl ?? item.url;
  if (outcome.status === "fetchable-arcgis" && curation.downloadUrl === undefined) {
    throw new Error(`${item.id}: an ArcGIS recipe needs the layer's URL as the downloadUrl`);
  }
  const dataUrl = givenUrl === item.url ? undefined : givenUrl;
  const sources = [item.url, ...(dataUrl === undefined ? [] : [dataUrl])].map((url) => ({ url, retrieved: probedOn, status: "live" }));
  const prefix = `${curation.namespace}-`;
  const alias = curation.id.startsWith(prefix) ? curation.id.slice(prefix.length) : "";
  if (outcome.status !== "not-fetchable") {
    checkFetchable(item.id, outcome);
  }
  const entry = parseEntry({
    id: curation.id,
    namespace: [curation.namespace],
    ...(alias === "" ? {} : { aliases: [alias] }),
    name: curation.name,
    ...(curation.description === undefined ? {} : { description: curation.description }),
    domain: domainOf(item),
    tags: [...new Set(item.fields)],
    category: "or/v1",
    sources,
    licence: curation.licence,
    citations: [],
    recipe: recipeOf(outcome, dataUrl === undefined ? 0 : 1, givenUrl),
    crosswalk: outcome.status === "not-fetchable" ? { file: OR_NODES_CROSSWALK } : crosswalkOf(outcome),
    expectedCounts: outcome.status !== "not-fetchable" && outcome.expectedNodes !== undefined ? { nodes: outcome.expectedNodes } : {},
    properties: { surveyId: item.id },
  });

  return {
    entry,
    outcome: { surveyId: item.id, id: curation.id, recipe: outcome.status === "not-fetchable" ? "not-fetchable" : "fetchable", ...(outcome.status === "not-fetchable" ? { reason: outcome.reason } : {}), flags: curation.flags },
  };
}

/** Compares survey ids by their number, so or-9 comes before or-10. */
function bySurveyNumber(left: string, right: string): number {
  return Number(left.slice("or-".length)) - Number(right.slice("or-".length));
}

/**
 * Converts the surveyed datasets with their curation into entries and a report. Every surveyed item must have exactly one curation and every curation must name a surveyed item, so a dataset cannot be dropped or invented silently; entry ids must be unique and not taken by an entry already in the catalogue.
 * @param survey - The survey.
 * @param curationDocument - The curation, as parsed JSON.
 * @param takenIds - The ids of entries the catalogue already holds from other sources.
 * @returns The entries in id order and the report, outcomes in survey order.
 * @throws Error naming the item and the problem on any inconsistency.
 */
export function convertSurvey(survey: SurveySource, curationDocument: unknown, takenIds: ReadonlySet<string>): { readonly entries: readonly Entry[]; readonly report: OrReport } {
  const curation: Curation = CurationSchema.parse(curationDocument);
  const byId = new Map<string, CurationItem>();
  for (const item of curation.items) {
    if (byId.has(item.surveyId)) {
      throw new Error(`${item.surveyId} has more than one curation`);
    }
    byId.set(item.surveyId, item);
  }
  const surveyIds = new Set(survey.entries.map((item) => item.id));
  for (const id of byId.keys()) {
    if (!surveyIds.has(id)) {
      throw new Error(`the curation names ${id}, which the survey does not have`);
    }
  }
  const entries: Entry[] = [];
  const outcomes: OrOutcome[] = [];
  const ids = new Map<string, string>();
  for (const item of [...survey.entries].sort((left, right) => bySurveyNumber(left.id, right.id))) {
    const curated = byId.get(item.id);
    if (curated === undefined) {
      throw new Error(`${item.id} has no curation`);
    }
    const clash = ids.get(curated.id);
    if (clash !== undefined || takenIds.has(curated.id)) {
      throw new Error(`${item.id}: the entry id ${curated.id} is already ${clash === undefined ? "an entry of another source" : `the id of ${clash}`}`);
    }
    ids.set(curated.id, item.id);
    const converted = convertItem(item, curated, curation.probedOn);
    entries.push(converted.entry);
    outcomes.push(converted.outcome);
  }

  return {
    entries: entries.sort((left, right) => (left.id < right.id ? -1 : 1)),
    report: { source: { survey: survey.survey, surveyed: survey.surveyed, probedOn: curation.probedOn }, outcomes },
  };
}
