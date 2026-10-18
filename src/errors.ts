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
