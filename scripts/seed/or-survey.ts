import { z } from "zod";
import { ColumnNameSchema, HttpUrlSchema, IdSchema, LicenceSchema } from "../../src/entry";

/* The operations-research survey the seed import reads (scripts/seed/sources/or-datasets-survey.json) and the curation that turns each surveyed item into a catalogue entry. The survey says what each item is and which fields of the routing-with-rewards node model it carries; the curation records, per item, what a download actually gives and how its columns map onto the or/v1 node, because that takes reading each source and is a judgement the survey cannot make. */

/** One surveyed dataset: an id, a title, the URL the survey recorded, the theme it was filed under and the node-model fields it carries. */
export const SurveyEntrySchema = z.looseObject({
  id: z.string().regex(/^or-\d+$/, { message: "must be or- and a number" }),
  title: z.string().min(1),
  url: z.string().min(1),
  theme: z.string().min(1),
  fields: z.array(z.string().min(1)),
});
export type SurveyEntry = z.infer<typeof SurveyEntrySchema>;

/** The survey document. */
export const SurveySourceSchema = z.looseObject({
  survey: z.string(),
  surveyed: z.string(),
  entries: z.array(SurveyEntrySchema),
});
export type SurveySource = z.infer<typeof SurveySourceSchema>;

/** How a target field's values read in a table: a number, text, or either (a deadline is a time of day as a number in a routing instance and a date as text in a case record). */
export type FieldKind = "number" | "text" | "either";

/** The or/v1 node fields a column can map onto, in the order a crosswalk lists them, so its rules do not depend on key order. */
export const TARGET_FIELD_NAMES = ["closed", "deadline", "duration", "lat", "lon", "opened", "prize", "prizeProbability", "skill", "status", "territory", "travelTime", "x", "y"] as const;
export type TargetField = (typeof TARGET_FIELD_NAMES)[number];

/** The kind of value each target field holds. */
export const TARGET_FIELDS: Readonly<Record<TargetField, FieldKind>> = {
  closed: "text",
  deadline: "either",
  duration: "number",
  lat: "number",
  lon: "number",
  opened: "text",
  prize: "number",
  prizeProbability: "number",
  skill: "text",
  status: "text",
  territory: "text",
  travelTime: "number",
  x: "number",
  y: "number",
};

/** The columns of a table by the target field each fills; a field is mapped at most once and a column fills at most one field. */
const FieldMapSchema = z
  .object({
    lat: ColumnNameSchema.optional(),
    lon: ColumnNameSchema.optional(),
    x: ColumnNameSchema.optional(),
    y: ColumnNameSchema.optional(),
    prize: ColumnNameSchema.optional(),
    prizeProbability: ColumnNameSchema.optional(),
    duration: ColumnNameSchema.optional(),
    travelTime: ColumnNameSchema.optional(),
    skill: ColumnNameSchema.optional(),
    territory: ColumnNameSchema.optional(),
    status: ColumnNameSchema.optional(),
    opened: ColumnNameSchema.optional(),
    closed: ColumnNameSchema.optional(),
    deadline: ColumnNameSchema.optional(),
  })
  .strict();
export type FieldMap = z.infer<typeof FieldMapSchema>;

/** Prose in the catalogue follows the house style, which has no dash used as a punctuation mark. */
const prose = (): z.ZodString => z.string().min(1).refine((text) => !/ -- |—|–/.test(text), { message: "must not use a dash as punctuation" });

/** A dataset whose download has a recipe: how to read the table, every column it has, and which of them fill the node's fields. Every column not mapped is dropped by a one-way rule, so what an entry leaves out is written down. */
export const FetchableOutcomeSchema = z
  .object({
    status: z.literal("fetchable"),
    encoding: z.enum(["utf-8", "latin1"]),
    delimiter: z.enum(["comma", "tab", "semicolon"]),
    skipLines: z.int().min(0),
    idColumn: ColumnNameSchema.nullable(),
    numericColumns: z.array(z.object({ column: ColumnNameSchema, factor: z.number().positive() }).strict()),
    columns: z.array(ColumnNameSchema).min(1),
    rowCount: z.int().min(0).optional(),
    map: FieldMapSchema,
  })
  .strict();
export type FetchableOutcome = z.infer<typeof FetchableOutcomeSchema>;

/** A dataset with no recipe yet, and why. */
export const NotFetchableOutcomeSchema = z.object({ status: z.literal("not-fetchable"), reason: prose() }).strict();

/** The curation of one surveyed item. */
export const CurationItemSchema = z
  .object({
    surveyId: z.string().regex(/^or-\d+$/, { message: "must be or- and a number" }),
    id: IdSchema,
    namespace: IdSchema,
    name: prose(),
    description: prose().optional(),
    licence: LicenceSchema,
    downloadUrl: HttpUrlSchema.optional(),
    flags: z.array(prose()),
    outcome: z.discriminatedUnion("status", [FetchableOutcomeSchema, NotFetchableOutcomeSchema]),
  })
  .strict();
export type CurationItem = z.infer<typeof CurationItemSchema>;

/** The curation document: the date its facts were read from the sources, and one item for each surveyed dataset. */
export const CurationSchema = z
  .object({
    probedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: "must be a date, YYYY-MM-DD" }),
    items: z.array(CurationItemSchema),
  })
  .strict();
export type Curation = z.infer<typeof CurationSchema>;
