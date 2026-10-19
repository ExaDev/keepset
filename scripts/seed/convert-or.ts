import { CrosswalkSchema, validateCrosswalk, type Crosswalk } from "twindex";
import { parseEntry, type Entry } from "../../src/entry";
import { columnNames } from "../../src/parsers/csv-table";
import { CurationSchema, TARGET_FIELD_NAMES, TARGET_FIELDS, type Curation, type CurationItem, type FetchableOutcome, type SurveyEntry, type SurveySource, type TargetField } from "./or-survey";

/** The shared crosswalk of an entry with no recipe yet: the document's meta and node ids, all that is known of a dataset whose columns have not been read into a mapping. */
export const OR_NODES_CROSSWALK = "crosswalks/or-v1/nodes.json";

/** The most rows a table may have to be given a recipe. A recipe reads the whole download into memory and builds an object per row, so a table of tens of millions of rows is not read by one fetch; such a dataset is imported without a recipe and says so. */
export const MAX_ROWS = 1_000_000;

/** The path of a Socrata resource endpoint: a four-by-four dataset id and an output format. */
const SOCRATA_RESOURCE_CSV = /^\/resource\/[a-z0-9]{4}-[a-z0-9]{4}\.csv$/;

/**
 * The URL a recipe downloads a table from. A Socrata resource endpoint returns a fixed small number of rows unless it is given a limit, so a table read from one is asked for as many rows as a recipe may read; every other URL is already the whole table.
 * @param url - The URL the survey or the curation gives for the table.
 * @returns The same URL, with the row limit set on a Socrata resource endpoint that has none.
 */
export function wholeTableUrl(url: string): string {
  const parsed = new URL(url);
  if (!SOCRATA_RESOURCE_CSV.test(parsed.pathname) || parsed.searchParams.has("$limit")) {
    return url;
  }
  parsed.searchParams.set("$limit", String(MAX_ROWS));

  return parsed.href;
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
 * The parser's names for a fetchable outcome's header, and the columns it emits, which are those names without the id column.
 * @param id - The surveyed item's id, for errors.
 * @param outcome - The outcome.
 * @returns Every name, and the columns of a row other than its id.
 * @throws Error naming the item when two header cells get the same name.
 */
function columnsOf(id: string, outcome: FetchableOutcome): { readonly names: readonly string[]; readonly columns: readonly string[] } {
  try {
    const names = columnNames(outcome.header, outcome.idColumn, 1);

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
function checkFetchable(id: string, outcome: FetchableOutcome): void {
  const fail = (message: string): never => {
    throw new Error(`${id}: ${message}`);
  };
  if (outcome.rowCount !== undefined && outcome.rowCount > MAX_ROWS) {
    fail(`the table has ${String(outcome.rowCount)} rows, more than ${String(MAX_ROWS)}, so it has no recipe`);
  }
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
 * The crosswalk of a fetchable outcome: the document's meta and node ids, each mapped column onto its field, and a one-way drop for every other column, so what the entry leaves out is written down and the round trip holds.
 * @param outcome - The outcome.
 * @returns The crosswalk document.
 * @throws Error when twindex finds the crosswalk structurally invalid.
 */
function crosswalkOf(outcome: FetchableOutcome): Crosswalk {
  const mapped = new Set(Object.values(outcome.map));
  const crosswalk = {
    source: "csv-table",
    target: "or/v1",
    rules: [
      { op: "move", from: "meta", to: "meta" },
      { op: "move", from: "nodes[].id", to: "nodes[].id" },
      ...TARGET_FIELD_NAMES.flatMap((field) => {
        const column = outcome.map[field];

        return column === undefined ? [] : [{ op: "move", from: `nodes[].${column}`, to: `nodes[].${field}` }];
      }),
    ],
    oneWay: columnsOf("crosswalk", outcome).columns.filter((column) => !mapped.has(column)).map((column) => ({ op: "drop", from: `nodes[].${column}`, direction: "encode" })),
  };
  const parsed = CrosswalkSchema.parse(crosswalk);
  const issues = validateCrosswalk(parsed);
  if (issues.length > 0) {
    throw new Error(`the crosswalk is invalid: ${issues.map((issue) => issue.message).join("; ")}`);
  }

  return parsed;
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
  const tableUrl = outcome.status === "fetchable" ? wholeTableUrl(givenUrl) : givenUrl;
  const dataUrl = tableUrl === item.url ? undefined : tableUrl;
  const sources = [item.url, ...(dataUrl === undefined ? [] : [dataUrl])].map((url) => ({ url, retrieved: probedOn, status: "live" }));
  const prefix = `${curation.namespace}-`;
  const alias = curation.id.startsWith(prefix) ? curation.id.slice(prefix.length) : "";
  if (outcome.status === "fetchable") {
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
    recipe:
      outcome.status === "fetchable"
        ? {
            status: "fetchable",
            source: dataUrl === undefined ? 0 : 1,
            archive: { kind: "none" },
            parser: { format: "csv-table", encoding: outcome.encoding, delimiter: outcome.delimiter, skipLines: outcome.skipLines, idColumn: outcome.idColumn, numericColumns: outcome.numericColumns },
          }
        : { status: "not-fetchable", reason: outcome.reason },
    crosswalk: outcome.status === "fetchable" ? crosswalkOf(outcome) : { file: OR_NODES_CROSSWALK },
    expectedCounts: {},
    properties: { surveyId: item.id },
  });

  return {
    entry,
    outcome: { surveyId: item.id, id: curation.id, recipe: outcome.status, ...(outcome.status === "not-fetchable" ? { reason: outcome.reason } : {}), flags: curation.flags },
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
