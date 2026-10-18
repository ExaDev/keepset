/** The root of this package's error taxonomy: every error keepset throws is a `KeepsetError`, so callers can catch the family with one check. */
export class KeepsetError extends Error {
  constructor(message: string) {
    super(message);
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

/** Thrown when an entry or a catalogue manifest fails its schema. Carries every issue found, not just the first, so one failed parse reports the whole document. */
export class CatalogueSyntaxError extends KeepsetError {
  readonly document: "entry" | "manifest";

  readonly issues: readonly SyntaxIssue[];

  constructor(document: "entry" | "manifest", issues: readonly SyntaxIssue[]) {
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
