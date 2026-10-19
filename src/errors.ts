/** The root of this package's error taxonomy: every error keepset throws is a `KeepsetError`, so callers can catch the family with one check. */
export class KeepsetError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Thrown when a category id names no category in the registry. Carries the ids that do exist, so the message says what would have been accepted. */
export class UnknownCategoryError extends KeepsetError {
  readonly categoryId: string;

  readonly knownIds: readonly string[];

  constructor(categoryId: string, knownIds: readonly string[]) {
    super(`unknown category ${JSON.stringify(categoryId)}: known categories are ${knownIds.join(", ")}`);
    this.categoryId = categoryId;
    this.knownIds = knownIds;
  }
}

/** One reason a catalogue document failed its schema: the dotted path of the offending value and what is wrong with it. Zod's own issue objects are collapsed into these so the public error surface stays stable across Zod versions. */
export interface SyntaxIssue {
  readonly path: string;
  readonly message: string;
}

/** Thrown when an entry, a catalogue manifest or a catalogue index fails its schema. Carries every issue found, not just the first, so one failed parse reports the whole document. */
export class CatalogueSyntaxError extends KeepsetError {
  readonly document: "entry" | "manifest" | "catalogue";

  readonly issues: readonly SyntaxIssue[];

  constructor(document: "entry" | "manifest" | "catalogue", issues: readonly SyntaxIssue[]) {
    super(`${document} syntax error: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
    this.document = document;
    this.issues = issues;
  }
}

/** Thrown by a parser when a file does not have the format its recipe names. `line` is 1-based, counting every line of the file, so it points at the offending line in an editor. */
export class NativeParseError extends KeepsetError {
  readonly format: string;

  readonly line: number;

  constructor(format: string, line: number, message: string) {
    super(`${format} line ${String(line)}: ${message}`);
    this.format = format;
    this.line = line;
  }
}

/** Thrown when an archive does not hold exactly one member the recipe's member selector matches, or is not a well-formed archive of its stated kind. */
export class ArchiveError extends KeepsetError {}

/** Thrown when no entry in the catalogue answers to the requested id, alias or qualified name. */
export class DatasetNotFoundError extends KeepsetError {
  readonly datasetId: string;

  constructor(datasetId: string) {
    super(`no dataset ${JSON.stringify(datasetId)} in the catalogue`);
    this.datasetId = datasetId;
  }
}

/** Thrown when a name that is not an entry's own id is a valid way to address more than one entry. Carries the ids of the entries it could mean, so the message says how to be specific. */
export class DatasetAmbiguousError extends KeepsetError {
  readonly requested: string;

  readonly candidateIds: readonly string[];

  constructor(name: string, candidateIds: readonly string[]) {
    super(`${JSON.stringify(name)} could mean more than one dataset: ${candidateIds.join(", ")}; use an id or a longer qualified name`);
    this.requested = name;
    this.candidateIds = candidateIds;
  }
}

/** The step of a recipe that failed: the recipe itself (not fetchable), downloading the source, unpacking the archive, parsing the native shape, applying the crosswalk, or validating the result against the category target. */
export type RecipeStep = "recipe" | "download" | "extract" | "parse" | "crosswalk" | "validate";

/** Thrown when running an entry's recipe fails. Names the entry and the failing step, and carries the underlying error as `cause`; a recipe never resolves to a partial or default-shaped result. */
export class RecipeError extends KeepsetError {
  readonly entryId: string;

  readonly step: RecipeStep;

  constructor(entryId: string, step: RecipeStep, message: string, options?: ErrorOptions) {
    super(`${entryId}: ${step} failed: ${message}`, options);
    this.entryId = entryId;
    this.step = step;
  }
}
