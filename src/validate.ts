import { validateCrosswalk } from "crossmap";
import type { Dataset } from "./catalogue";
import { EntrySchema, toIssues } from "./entry";
import type { SyntaxIssue } from "./errors";

/**
 * Checks a dataset as the catalogue holds it: the entry against the entry schema, and its crosswalk against crossmap's structural validation and the entry's category. A catalogue index is checked the same way when it is built, so a bundled dataset is valid unless the package itself is broken; the check is what a contributor runs on an entry they are writing.
 * @param dataset - The dataset.
 * @returns Every issue found, with paths from the dataset's root (`entry.` or `crosswalk.`); empty when the dataset is valid.
 */
export function validateDataset(dataset: Dataset): SyntaxIssue[] {
  const issues: SyntaxIssue[] = [];
  const entry = EntrySchema.safeParse(dataset.entry);
  if (!entry.success) {
    issues.push(...toIssues(entry.error).map((issue) => ({ path: `entry.${issue.path}`, message: issue.message })));
  }
  const { rules, oneWay } = dataset.crosswalk;
  for (const issue of validateCrosswalk(dataset.crosswalk)) {
    // crossmap counts two-way rules first and continues into the one-way rules; an issue of the rule list as a whole (two rules sharing a path) carries an index that names no rule.
    const { ruleIndex } = issue;
    const path = ruleIndex >= 0 && ruleIndex < rules.length ? `crosswalk.rules.${String(ruleIndex)}` : ruleIndex >= rules.length && ruleIndex < rules.length + oneWay.length ? `crosswalk.oneWay.${String(ruleIndex - rules.length)}` : "crosswalk";
    issues.push({ path, message: issue.message });
  }
  if (dataset.crosswalk.target !== dataset.entry.category) {
    issues.push({ path: "crosswalk.target", message: `must be the entry's category, ${dataset.entry.category}` });
  }

  return issues;
}
