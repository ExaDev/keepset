/* Checks a curation file, whole or a slice of it, against the survey and the import's rules, and reports every problem rather than the first. This is the check a curator runs while writing a curation; the import itself refuses the same problems.

   pnpm exec tsx scripts/seed/or-validate.ts <curation.json> */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { convertItem } from "./convert-or";
import { CurationSchema, SurveySourceSchema } from "./or-survey";

const here = dirname(fileURLToPath(import.meta.url));
const [path] = process.argv.slice(2);
if (path === undefined) {
  throw new Error("usage: or-validate <curation.json>");
}
const survey = SurveySourceSchema.parse(JSON.parse(readFileSync(join(here, "sources/or-datasets-survey.json"), "utf8")));
const parsed = CurationSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
if (!parsed.success) {
  console.log(`the file does not match the curation schema:\n${parsed.error.issues.map((issue) => `  ${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`).join("\n")}`);
  process.exitCode = 1;
} else {
  const byId = new Map(survey.entries.map((item) => [item.id, item]));
  const seenIds = new Map<string, string>();
  const problems: string[] = [];
  for (const curated of parsed.data.items) {
    const item = byId.get(curated.surveyId);
    if (item === undefined) {
      problems.push(`${curated.surveyId}: not a surveyed item`);
      continue;
    }
    const clash = seenIds.get(curated.id);
    if (clash !== undefined) {
      problems.push(`${curated.surveyId}: the entry id ${curated.id} is also the id of ${clash}`);
    }
    seenIds.set(curated.id, curated.surveyId);
    try {
      convertItem(item, curated, parsed.data.probedOn);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  console.log(problems.length === 0 ? `${String(parsed.data.items.length)} items are valid.` : `${String(problems.length)} problems in ${String(parsed.data.items.length)} items:\n${problems.map((problem) => `  ${problem}`).join("\n")}`);
  process.exitCode = problems.length === 0 ? 0 : 1;
}
