import { CrosswalkSchema } from "crossmap";
import { z } from "zod";
import { CategoryIdSchema, countedKeys } from "./categories";
import { define } from "./define";
import { namesOf } from "./names";
import { CatalogueSyntaxError, type SyntaxIssue } from "./errors";
import { recordOf } from "./record";
import { JsonScalarSchema } from "./targets/json-scalar";

/** A stable identifier: an entry id, a catalogue id. It starts with a letter or digit, so no id can be `__proto__` or any other name that begins with an underscore. Entry ids stay the same across forks, which is what lets two catalogues be compared entry by entry. */
export const IdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, {
  message: "must start with a letter or digit and contain only letters, digits, '.', '_' and '-'",
});

/** A key of an entry's `properties` or `expectedCounts` record: an identifier that starts with a letter, so it can never be `__proto__` or another name Object.prototype reacts to on assignment. */
/** A subject: the field of study a dataset is relevant to, as a lowercase slug of words joined by hyphens, such as `operations-research`. It is separate from the entry's domain (its topic), its tags (the node fields it carries) and its namespace (the source it comes from), and it is the value a search filters by. */
export const SubjectSchema = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, { message: "must be a lowercase slug of words joined by hyphens, such as operations-research" });

/** An alias: an id, or a path of ids joined by `/` such as `foo/graphs/bar`. A bare id is a name inside the entry's own namespace; a path is a name of its own, in the group its leading segments name. The segment pattern repeats the one in `IdSchema` so that each part of a path is an id. */
export const AliasSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/, {
  message: "must be an id, or ids joined by '/', each starting with a letter or digit and containing only letters, digits, '.', '_' and '-'",
});

/** The path a dataset sits under in a collection, outermost segment first, such as `["suitesparse", "gset"]`. Each segment is an id, so a segment can never contain the `/` that joins a namespace to a name. */
export const NamespaceSchema = z.array(IdSchema).min(1);
export type Namespace = z.infer<typeof NamespaceSchema>;

const RecordKeySchema = z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/, { message: "must be a letter followed by letters or digits" });

/** A calendar date, `YYYY-MM-DD`. */
const IsoDateSchema = z.iso.date();

/** An http or https URL: the only schemes a recipe may download from. Any host is allowed, an address or a single-label name included, so a fork can point a recipe at a server on its own network. */
export const HttpUrlSchema = z.url({ protocol: /^https?$/ });

/** A Wayback Machine timestamp, `YYYYMMDD` or `YYYYMMDDhhmmss`: the moment the snapshot is pinned to. */
export const WaybackTimestampSchema = z.string().regex(/^\d{8}(?:\d{6})?$/, { message: "must be a Wayback timestamp, YYYYMMDD or YYYYMMDDhhmmss" });

/**
 * The Wayback Machine URL of a snapshot of `url` at `timestamp`: the page form a person follows. The raw bytes a recipe downloads come from the `id_` form, which `fetchDataset` derives from this one.
 * @param timestamp - A Wayback timestamp.
 * @param url - The original URL.
 * @returns The snapshot URL.
 */
export function waybackUrl(timestamp: string, url: string): string {
  return `https://web.archive.org/web/${timestamp}/${url}`;
}

/** A pinned Wayback Machine snapshot of a source. The timestamp is part of the recipe's reproducibility, not incidental metadata, so it travels with the URL and the two are checked against each other. */
export const SnapshotSchema = z
  .object({
    url: HttpUrlSchema,
    timestamp: WaybackTimestampSchema,
  })
  .strict();
export type Snapshot = z.infer<typeof SnapshotSchema>;

/**
 * Where a dataset's bytes come from. A `dead` source no longer serves the bytes the recipe was written against and must carry the snapshot the recipe fetches instead; a `live` source may also carry one, as the pinned record of what it served. The snapshot URL must be exactly `waybackUrl(timestamp, url)`.
 */
export const SourceSchema = z
  .object({
    url: HttpUrlSchema,
    retrieved: IsoDateSchema,
    status: z.enum(["live", "dead"]),
    snapshot: SnapshotSchema.optional(),
  })
  .strict()
  .superRefine((source, ctx) => {
    if (source.status === "dead" && source.snapshot === undefined) {
      ctx.addIssue({ code: "custom", path: ["snapshot"], message: "a dead source must pin the Wayback snapshot its recipe fetches" });
    }
    if (source.snapshot !== undefined && source.snapshot.url !== waybackUrl(source.snapshot.timestamp, source.url)) {
      ctx.addIssue({ code: "custom", path: ["snapshot", "url"], message: `must be ${waybackUrl(source.snapshot.timestamp, source.url)}, the snapshot of this source's url at this timestamp` });
    }
  });
export type Source = z.infer<typeof SourceSchema>;

/** The licence a dataset is published under: an SPDX identifier, a named licence with the URL of its terms, or a statement that the source records none. A licence the source does not state is recorded as unrecorded rather than guessed. */
export const LicenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("spdx"), id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.+-]*$/, { message: "must be an SPDX licence identifier" }) }).strict(),
  z.object({ kind: z.literal("custom"), name: z.string().min(1), url: HttpUrlSchema }).strict(),
  z.object({ kind: z.literal("unrecorded") }).strict(),
]);
export type Licence = z.infer<typeof LicenceSchema>;

/** A work to cite for the dataset: a formatted reference, with its DOI or URL where the source records one. */
export const CitationSchema = z
  .object({
    text: z.string().min(1),
    doi: z
      .string()
      .regex(/^10\.\d{4,9}\/\S+$/, { message: "must be a bare DOI, 10.<registrant>/<suffix>" })
      .optional(),
    url: HttpUrlSchema.optional(),
  })
  .strict();
export type Citation = z.infer<typeof CitationSchema>;

/** A relative path inside an archive or a catalogue: `/`-separated segments, none empty, `.` or `..`, so it can never climb out of the directory it is resolved against. */
export const RelativePathSchema = z.string().refine((path) => path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."), {
  message: "must be a relative path of non-empty segments with no '.' or '..'",
});

/** A regular expression a member path must match in full, in JavaScript syntax; it must compile, so a recipe with a malformed pattern is refused when the entry is parsed and not when it runs. */
const MemberPatternSchema = z.string().min(1).refine(
  (pattern) => {
    try {
      new RegExp(`^(?:${pattern})$`, "u");

      return true;
    } catch {
      return false;
    }
  },
  { message: "must be a valid regular expression" },
);

/** Which file of an archive to read: a member path, matched against a member's whole path or its trailing segments (so `net.gml` finds `net/net.gml`), the member whose name ends with one of a list of extensions (a format can have several, such as Pajek's `.net` and `.paj`), or the member whose whole path matches a regular expression (for an archive whose instance files cannot be told from its readmes and solutions by extension). A `member` selector must match exactly one member when the recipe runs, a `members` selector at least one; macOS resource-fork members (`__MACOSX/` and `._` files) never match. */
export const ArchiveMemberSchema = z.union([
  z.object({ path: RelativePathSchema }).strict(),
  z.object({ extensions: z.array(z.string().regex(/^\.[A-Za-z0-9][A-Za-z0-9.]*$/, { message: "must be a file extension such as .mtx" })).min(1) }).strict(),
  z.object({ pattern: MemberPatternSchema }).strict(),
]);
export type ArchiveMember = z.infer<typeof ArchiveMemberSchema>;

/** The archive kinds that hold several files, from which a recipe selects one (`member`) or every one a selector matches (`members`). */
const FileArchiveKindSchema = z.enum(["zip", "tar", "tar.gz"]);

/** An archive a collection is read from: every file a selector matches, at least one. */
export const CollectionArchiveSchema = z.object({ kind: FileArchiveKindSchema, members: ArchiveMemberSchema }).strict();

/** How a member that is itself an archive unpacks into the file the parser reads: gunzipped, or one member of it selected. It nests one level, which is as deep as any source in the catalogue goes. */
export const InnerArchiveSchema = z.union([z.object({ kind: z.literal("gzip") }).strict(), z.object({ kind: FileArchiveKindSchema, member: ArchiveMemberSchema }).strict()]);
export type InnerArchive = z.infer<typeof InnerArchiveSchema>;

/** How the downloaded bytes unpack into the file the parser reads, or for a collection the files it reads one by one. A `members` selector gives every member it matches, at least one, in path order. A member that is an archive in its turn (a contest bundle that ships its problems as a zip inside the zip) is unpacked by `inner`. A workbook (`xlsx`) is read as the CSV of its named sheet, with dates as ISO 8601 text, for the `csv-table` parser. */
export const ArchiveSchema = z.union([
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("gzip") }).strict(),
  z.object({ kind: FileArchiveKindSchema, member: ArchiveMemberSchema, inner: InnerArchiveSchema.optional() }).strict(),
  CollectionArchiveSchema,
  z.object({ kind: z.literal("xlsx"), sheet: z.string().min(1) }).strict(),
]);
export type Archive = z.infer<typeof ArchiveSchema>;
/** An archive that gives the one file a document is read from. */
export type DocumentArchive = Exclude<Archive, { readonly members: ArchiveMember }>;
/** An archive that gives every file a collection is read from. */
export type CollectionArchive = z.infer<typeof CollectionArchiveSchema>;

const ColumnSchema = z.int().min(0);

/** The text encoding of the unpacked file. Decoding is strict: bytes that are not valid in the stated encoding fail the recipe rather than turning into replacement characters. */
const EncodingSchema = z.enum(["utf-8", "latin1"]);

/** A column of a table as the table parser names it: the header with every run of characters outside letters, digits and underscore replaced by one underscore, so it is a valid segment of a crossmap path. */
export const ColumnNameSchema = z.string().regex(/^[A-Za-z](?:[A-Za-z0-9_]*[A-Za-z0-9])?$/, { message: "must be a column name as the parser spells it: letters, digits and underscores, starting with a letter and not ending with an underscore" });

/** The parser that reads the unpacked file into the dataset's native JSON shape, with the options that format needs. Every option is stated in the entry, so a recipe reads the same way wherever it runs. */
export const ParserSchema = z.discriminatedUnion("format", [
  z
    .object({
      format: z.literal("edge-list"),
      encoding: EncodingSchema,
      delimiter: z.enum(["detect", "whitespace", "tab", "comma", "space"]),
      skipLines: z.int().min(0),
      commentPrefixes: z.array(z.string().min(1)),
      sourceColumn: ColumnSchema,
      targetColumn: ColumnSchema,
    })
    .strict()
    .refine((parser) => parser.sourceColumn !== parser.targetColumn, { message: "sourceColumn and targetColumn must differ", path: ["targetColumn"] }),
  z.object({ format: z.literal("matrix-market"), encoding: EncodingSchema }).strict(),
  z.object({ format: z.literal("gml"), encoding: EncodingSchema }).strict(),
  z.object({ format: z.literal("pajek"), encoding: EncodingSchema }).strict(),
  z
    .object({
      format: z.literal("ucinet-dl"),
      encoding: EncodingSchema,
      /** Which of the file's `NM` matrices is the graph, by its 1-based position: a DL file often holds several relations over the same actors, and the recipe reads one. */
      matrix: z.int().min(1),
    })
    .strict(),
  z.object({ format: z.literal("customer-points"), encoding: EncodingSchema }).strict(),
  z.object({ format: z.literal("solomon"), encoding: EncodingSchema }).strict(),
  z.object({ format: z.literal("top"), encoding: EncodingSchema }).strict(),
  z.object({ format: z.literal("toptw"), encoding: EncodingSchema }).strict(),
  z.object({ format: z.literal("tsplib"), encoding: EncodingSchema }).strict(),
  z.object({ format: z.literal("verolog-2019"), encoding: z.literal("utf-8") }).strict(),
  z.object({ format: z.literal("vrp-rep"), encoding: z.literal("utf-8") }).strict(),
  z
    .object({
      format: z.literal("csv-table"),
      encoding: EncodingSchema,
      delimiter: z.enum(["comma", "tab", "semicolon"]),
      skipLines: z.int().min(0),
      idColumn: ColumnNameSchema.nullable(),
      numericColumns: z.array(z.object({ column: ColumnNameSchema, factor: z.number().positive() }).strict()),
      columns: z.array(ColumnNameSchema).optional(),
      /** Cell texts, besides the empty cell, that stand for a missing value (`NA`): such a cell is null in every column, numeric or not. */
      nullValues: z.array(z.string().min(1)).optional(),
    })
    .strict()
    .refine((parser) => new Set(parser.numericColumns.map((numeric) => numeric.column)).size === parser.numericColumns.length, { message: "a column may be declared numeric once", path: ["numericColumns"] })
    .refine((parser) => parser.columns === undefined || new Set(parser.columns).size === parser.columns.length, { message: "a column may be listed once", path: ["columns"] }),
  z
    .object({
      format: z.literal("geojson"),
      encoding: z.literal("utf-8"),
      idColumn: ColumnNameSchema.nullable(),
      numericColumns: z.array(z.object({ column: ColumnNameSchema, factor: z.number().positive() }).strict()),
      dateColumns: z.array(ColumnNameSchema),
      columns: z.array(ColumnNameSchema).min(1),
    })
    .strict()
    .refine((parser) => new Set(parser.columns).size === parser.columns.length, { message: "a column may be listed once", path: ["columns"] })
    .refine((parser) => parser.idColumn === null || !parser.columns.includes(parser.idColumn), { message: "the id column is the row's id, so it is not listed among the columns", path: ["columns"] })
    .refine((parser) => parser.numericColumns.every((numeric) => parser.columns.includes(numeric.column)) && parser.dateColumns.every((date) => parser.columns.includes(date)), { message: "a numeric or date column must be among the columns kept", path: ["columns"] })
    .refine((parser) => new Set([...parser.numericColumns.map((numeric) => numeric.column), ...parser.dateColumns]).size === parser.numericColumns.length + parser.dateColumns.length, { message: "a column may be numeric or a date, not both, and once", path: ["dateColumns"] }),
]);
export type Parser = z.infer<typeof ParserSchema>;

/** Where a source is a paged query and not one file. An ArcGIS feature layer returns a limited number of features per request: the source URL is the layer's, the download reads every page in `orderBy` order and the parser reads the one GeoJSON collection they make. A Socrata resource endpoint (`/resource/<id>.csv`) is read `pageSize` rows at a time in the order of its row ids, a CKAN datastore dump (`/datastore/dump/<id>`) and an OpenFEMA entity (`/api/open/v<n>/<Entity>`, with any `$select` or `$filter` in the source URL) `pageSize` rows at a time, each page a CSV with its own header; the download joins them into the one CSV the parser reads, so no single response has to survive a long transfer. */
export const PagingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("arcgis-query"), orderBy: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, { message: "must be a field name of the layer" }) }).strict(),
  z.object({ kind: z.literal("socrata-resource"), pageSize: z.int().min(1) }).strict(),
  z.object({ kind: z.literal("ckan-datastore"), pageSize: z.int().min(1) }).strict(),
  z.object({ kind: z.literal("openfema"), pageSize: z.int().min(1) }).strict(),
]);
export type Paging = z.infer<typeof PagingSchema>;

/** How to obtain the dataset: a fetchable recipe naming the source (by index into `sources`), the archive layout and the parser, or a statement that no declarative recipe exists yet and why. */
export const RecipeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("fetchable"), source: z.int().min(0), paging: PagingSchema.optional(), archive: ArchiveSchema, parser: ParserSchema }).strict(),
  z.object({ status: z.literal("not-fetchable"), reason: z.string().min(1) }).strict(),
]);
export type Recipe = z.infer<typeof RecipeSchema>;

/** The crossmap crosswalk from the native shape to the category target: the document inline, or a `.json` file path relative to the catalogue root, so entries that share a native shape share one crosswalk. */
export const CrosswalkReferenceSchema = z.union([CrosswalkSchema, z.object({ file: RelativePathSchema.refine((path) => path.endsWith(".json"), { message: "must name a .json file" }) }).strict()]);
export type CrosswalkReference = z.infer<typeof CrosswalkReferenceSchema>;

/** The meta keys a fetched result takes from the entry's own descriptor, which its `properties` therefore may not also set. */
export const RESERVED_META_KEYS = ["id", "name"] as const;

/**
 * One catalogue entry: the descriptor (id, optional namespace and aliases, name, description, domain, subjects, tags), the category whose target the entry resolves to, where the bytes come from, the licence and citations, the recipe, the crosswalk, the counts a fetched result is expected to have and the dataset's recorded properties. The kind of data is the category's (`kindOf(category)`), never a second field that could disagree with it.
 */
export const EntrySchema = define(
  z
    .object({
      id: IdSchema,
      namespace: NamespaceSchema.optional(),
      aliases: z.array(AliasSchema).min(1).optional(),
      name: z.string().min(1),
      description: z.string().min(1).optional(),
      domain: z.string().min(1).optional(),
      subjects: z
        .array(SubjectSchema)
        .min(1)
        .refine((subjects) => new Set(subjects).size === subjects.length, { message: "subjects must be unique" })
        .optional(),
      tags: z.array(z.string().min(1)).refine((tags) => new Set(tags).size === tags.length, { message: "tags must be unique" }),
      category: CategoryIdSchema,
      sources: z.array(SourceSchema).min(1),
      licence: LicenceSchema,
      citations: z.array(CitationSchema),
      recipe: RecipeSchema,
      crosswalk: CrosswalkReferenceSchema,
      expectedCounts: recordOf(RecordKeySchema, z.int().min(0)),
      properties: recordOf(RecordKeySchema, JsonScalarSchema),
    })
    .strict()
    .superRefine((entry, ctx) => {
      const { aliases = [] } = entry;
      if (new Set(aliases).size !== aliases.length || aliases.includes(entry.id)) {
        ctx.addIssue({ code: "custom", path: ["aliases"], message: "aliases must be unique and differ from the entry's own id" });
      }
      const { full } = namesOf(entry);
      if (new Set(full).size !== full.length) {
        ctx.addIssue({ code: "custom", path: ["aliases"], message: "the entry's id and aliases must not give the same fully qualified name twice" });
      }
      if (entry.recipe.status === "fetchable" && entry.recipe.source >= entry.sources.length) {
        ctx.addIssue({ code: "custom", path: ["recipe", "source"], message: `names source ${String(entry.recipe.source)} but the entry has ${String(entry.sources.length)}` });
      }
      if ("target" in entry.crosswalk && entry.crosswalk.target !== entry.category) {
        ctx.addIssue({ code: "custom", path: ["crosswalk", "target"], message: `must be the entry's category, ${entry.category}` });
      }
      const counted = countedKeys(entry.category, entry.recipe.status === "fetchable" && "members" in entry.recipe.archive);
      for (const key of Object.keys(entry.expectedCounts)) {
        if (!counted.includes(key)) {
          ctx.addIssue({ code: "custom", path: ["expectedCounts", key], message: `${entry.category} ${entry.recipe.status === "fetchable" && "members" in entry.recipe.archive ? "collections count" : "counts"} only ${counted.join(", ")}` });
        }
      }
      for (const key of RESERVED_META_KEYS) {
        if (Object.hasOwn(entry.properties, key)) {
          ctx.addIssue({ code: "custom", path: ["properties", key], message: `${key} is set from the entry itself in a fetched result's meta, so it cannot be a property` });
        }
      }
    }),
);
export type Entry = z.infer<typeof EntrySchema>;

/**
 * Collapses Zod issues into the package's own issue shape, so the public error surface stays stable across Zod versions.
 * @param error - A Zod error.
 * @returns One issue per Zod issue, with its path written as dotted text.
 */
export function toIssues(error: z.ZodError): SyntaxIssue[] {
  return error.issues.map((issue) => ({ path: issue.path.map(String).join(".") || "(root)", message: issue.message }));
}

/**
 * Parses an unknown value as a catalogue entry.
 * @param doc - The candidate entry document.
 * @returns The validated entry.
 * @throws CatalogueSyntaxError carrying every issue found.
 */
export function parseEntry(doc: unknown): Entry {
  const result = EntrySchema.safeParse(doc);
  if (!result.success) {
    throw new CatalogueSyntaxError("entry", toIssues(result.error));
  }

  return result.data;
}
