/* Audits the operations-research curation's licences against the platforms' own records.

   pnpm run seed:audit:licences [--print]

   For every curated item whose survey URL is a dataset on a platform that keeps a machine-readable licence record (Socrata, CKAN, ArcGIS Hub, GitHub, Hugging Face, Zenodo), fetches the record and exits non-zero when it disagrees with the curation about whether the dataset states a licence: a curated item that records none while the record names one, or one that records a licence while the record names none. It needs the network, so it is not part of `seed:check`, which proves only that every item records the record it read. --print lists each reading. */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { licenceMetadata } from "./licence";
import { readLicenceRecord } from "./licence-records";
import { CurationSchema, SurveySourceSchema } from "./or-survey";

const HTTP_NOT_FOUND = 404;
const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: { print: { type: "boolean" } }, strict: true });

const survey = SurveySourceSchema.parse(JSON.parse(readFileSync(join(here, "sources/or-datasets-survey.json"), "utf8")));
const curation = CurationSchema.parse(JSON.parse(readFileSync(join(here, "sources/or-survey-curation.json"), "utf8")));
const urlOf = new Map(survey.entries.map((entry) => [entry.id, entry.url]));

/**
 * Fetches a licence record.
 * @param url - The record's URL.
 * @returns The parsed record, or `undefined` for a 404 (GitHub's answer for a repository without a licence file).
 * @throws When the platform answers anything else that is not success.
 */
async function fetchRecord(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { accept: "application/json", "user-agent": "keepset-licence-audit" } });
  if (response.status === HTTP_NOT_FOUND) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`${url} answered ${String(response.status)}`);
  }

  return response.json();
}

const audited = curation.items.flatMap((item) => {
  const pageUrl = urlOf.get(item.surveyId);
  const metadata = pageUrl === undefined ? undefined : licenceMetadata(pageUrl);

  return metadata === undefined ? [] : [{ item, metadata }];
});
// Each record is on a different dataset, and a platform that hosts several is asked one dataset at a time by the few items it has, so the requests go out together.
const readings = await Promise.all(audited.map(async ({ metadata }) => readLicenceRecord(metadata.platform, await fetchRecord(metadata.url))));

const mismatches: string[] = [];
for (const [index, { item, metadata }] of audited.entries()) {
  const reading = readings[index];
  if (reading === undefined) {
    throw new Error(`no reading for ${item.id}`);
  }
  // A licence the curation read from somewhere other than the platform's record (a licence file under another name, a portal's terms page) is not contradicted by the record's silence.
  const curatedStates = "licence" in item.licence;
  const readElsewhere = "licence" in item.licence && item.licence.statedAt !== metadata.url;
  if (values.print === true) {
    console.log(`${item.id} | ${metadata.platform} | ${metadata.url} | curated ${curatedStates ? "states" : "none"} | record ${reading.states ? "states" : "none"}: ${reading.summary}`);
  }
  if (curatedStates !== reading.states && !(readElsewhere && !reading.states)) {
    mismatches.push(`${item.id}: curation ${curatedStates ? "records a licence" : "records none"}, but ${metadata.url} ${reading.states ? `names ${reading.summary}` : "names none"}`);
  }
}
if (mismatches.length > 0) {
  console.error(mismatches.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Every curated licence agrees with its platform's record.");
}
