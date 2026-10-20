import { z } from "zod";
import { HttpUrlSchema, LicenceSchema, type Licence } from "../../src/entry";

/* How the seed imports learn an entry's licence. An entry's licence is never a default of the importer: every dataset's licence comes from curation that records where the licence was read, so a licence nobody has read cannot reach the catalogue as `unrecorded`. Two shapes of curation exist and share these terms: the graph import keeps one record per publisher (a collection that states one licence for everything it hosts) plus a record per dataset for the exceptions, and the operations-research import keeps one record per surveyed item. */

const EM_DASH_CODE_POINT = 0x2014;
const EN_DASH_CODE_POINT = 0x2013;
/** An em-dash, which curation prose may not use as punctuation. */
export const EM_DASH = String.fromCodePoint(EM_DASH_CODE_POINT);
const EN_DASH = String.fromCodePoint(EN_DASH_CODE_POINT);

/** The dashes that must not punctuate curation prose: an em-dash, an en-dash and a spaced double hyphen. */
const DASH_PUNCTUATION = new RegExp([EM_DASH, EN_DASH, ` ${"-".repeat(2)} `].join("|"));

/** Prose in curation: non-empty and free of dashes used as punctuation, so it can be copied into any document. */
export const prose = (): z.ZodString => z.string().min(1).refine((text) => !DASH_PUNCTUATION.test(text), { message: "must not use a dash as punctuation" });

/** A licence the source states: an SPDX identifier or a named licence with the URL of its terms, never `unrecorded`. */
export type StatedLicence = Exclude<Licence, { readonly kind: "unrecorded" }>;
export const StatedLicenceSchema = LicenceSchema.refine((licence): licence is StatedLicence => licence.kind !== "unrecorded", { message: "must be an SPDX or custom licence: a source that states none is recorded with readAt and reason" });

/** Terms a source states: the licence, the page or file that states it and the words that do. */
export const StatedTermsSchema = z.object({ licence: StatedLicenceSchema, statedAt: HttpUrlSchema, statement: prose() }).strict();
export type StatedTerms = z.infer<typeof StatedTermsSchema>;

/** A source that states no terms: every page or file read for them, and what the reading found. */
export const UnstatedTermsSchema = z.object({ readAt: z.array(HttpUrlSchema).min(1), reason: prose() }).strict();
export type UnstatedTerms = z.infer<typeof UnstatedTermsSchema>;

/** What reading a source found: stated terms or a record that none are stated. The two never share a key, so the union needs no tag. */
export const LicenceTermsSchema = z.union([StatedTermsSchema, UnstatedTermsSchema]);
export type LicenceTerms = z.infer<typeof LicenceTermsSchema>;

/**
 * The entry licence terms resolve to.
 * @param terms - What reading the source found.
 * @returns The stated licence, or `unrecorded` for a source that states none.
 */
export function licenceOf(terms: LicenceTerms): Licence {
  return "licence" in terms ? terms.licence : { kind: "unrecorded" };
}

const PublisherIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, { message: "must be a lowercase slug" });

/** One publisher of datasets: the URL prefixes its downloads live under, and either the terms it states for everything it hosts or the fact that each dataset states its own (`perDataset`), in which case every one of its datasets needs a dataset record. */
export const PublisherSchema = z.union([
  z.object({ id: PublisherIdSchema, name: prose(), prefixes: z.array(HttpUrlSchema).min(1), terms: LicenceTermsSchema }).strict(),
  z.object({ id: PublisherIdSchema, name: prose(), prefixes: z.array(HttpUrlSchema).min(1), perDataset: z.literal(true) }).strict(),
]);
export type Publisher = z.infer<typeof PublisherSchema>;

/** The graph import's licence curation: the date it was read, the publishers, and the datasets whose own terms differ from their publisher's (or whose publisher states terms per dataset). */
export const GraphLicencesSchema = z
  .object({
    readOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: "must be a date, YYYY-MM-DD" }),
    publishers: z.array(PublisherSchema),
    datasets: z.record(z.string().min(1), LicenceTermsSchema),
  })
  .strict()
  .superRefine((curation, ctx) => {
    const ids = new Set<string>();
    const prefixes = new Set<string>();
    for (const [index, publisher] of curation.publishers.entries()) {
      if (ids.has(publisher.id)) {
        ctx.addIssue({ code: "custom", path: ["publishers", index, "id"], message: `publisher ${publisher.id} is listed twice` });
      }
      ids.add(publisher.id);
      for (const prefix of publisher.prefixes) {
        if (prefixes.has(prefix)) {
          ctx.addIssue({ code: "custom", path: ["publishers", index, "prefixes"], message: `${prefix} belongs to two publishers` });
        }
        prefixes.add(prefix);
      }
    }
  });
export type GraphLicences = z.infer<typeof GraphLicencesSchema>;

/** The licences of one import run, remembering which curation records it used so stale ones can be refused. */
export interface GraphLicenceResolver {
  /**
   * Resolves one dataset's licence.
   * @param datasetId - The entry id.
   * @param sourceUrl - The URL of the source the entry's recipe fetches, or its first source when it has no recipe.
   * @returns The licence its curation records.
   * @throws When no curation covers the dataset, or its publisher states terms per dataset and the dataset has none.
   */
  readonly resolve: (datasetId: string, sourceUrl: string) => Licence;
  /**
   * Checks that every curation record was used.
   * @throws When a dataset record names a dataset the import did not resolve, or a publisher served none.
   */
  readonly assertAllUsed: () => void;
}

/**
 * Builds the resolver for the graph import. A dataset record wins over its publisher; otherwise the publisher whose longest prefix starts the source URL decides.
 * @param curation - The parsed licence curation.
 * @returns The resolver.
 */
export function graphLicenceResolver(curation: GraphLicences): GraphLicenceResolver {
  const usedPublishers = new Set<string>();
  const usedDatasets = new Set<string>();
  const byPrefix = curation.publishers.flatMap((publisher) => publisher.prefixes.map((prefix) => ({ prefix, publisher }))).sort((left, right) => right.prefix.length - left.prefix.length);

  return {
    resolve(datasetId, sourceUrl) {
      const own = Object.hasOwn(curation.datasets, datasetId) ? curation.datasets[datasetId] : undefined;
      const match = byPrefix.find(({ prefix }) => sourceUrl.startsWith(prefix));
      if (match !== undefined) {
        usedPublishers.add(match.publisher.id);
      }
      if (own !== undefined) {
        usedDatasets.add(datasetId);

        return licenceOf(own);
      }
      if (match === undefined) {
        throw new Error(`no licence curation covers ${datasetId} (${sourceUrl}): read the publisher's terms and add a publisher or dataset record to graph-licences.json`);
      }
      if ("perDataset" in match.publisher) {
        throw new Error(`${match.publisher.name} states terms per dataset, and graph-licences.json has no record for ${datasetId}: read its page and add one`);
      }

      return licenceOf(match.publisher.terms);
    },
    assertAllUsed() {
      const unusedDatasets = Object.keys(curation.datasets).filter((id) => !usedDatasets.has(id));
      if (unusedDatasets.length > 0) {
        throw new Error(`graph-licences.json has dataset records for datasets the import did not produce: ${unusedDatasets.join(", ")}`);
      }
      const unusedPublishers = curation.publishers.filter((publisher) => !usedPublishers.has(publisher.id)).map((publisher) => publisher.id);
      if (unusedPublishers.length > 0) {
        throw new Error(`graph-licences.json has publishers that no dataset's source falls under: ${unusedPublishers.join(", ")}`);
      }
    },
  };
}

/** The platforms whose datasets each carry a licence in a machine-readable record. */
export type LicencePlatform = "socrata" | "ckan" | "arcgis" | "github" | "huggingface" | "zenodo";

/** A platform's machine-readable record of one dataset's licence. */
export interface LicenceMetadata {
  readonly platform: LicencePlatform;
  /** The URL of the record that holds the dataset's licence. */
  readonly url: string;
}

const SOCRATA_ID = "[a-z0-9]{4}-[a-z0-9]{4}";
/** A Socrata dataset in a URL's path: a resource or view API path, or a landing page `/<category>/<title>/<id>`. */
const SOCRATA_PATHS: readonly RegExp[] = [new RegExp(`^/resource/(${SOCRATA_ID})(?:\\.|$)`), new RegExp(`^/api/views/(${SOCRATA_ID})(?:[/.]|$)`), new RegExp(`^/[^/]+/[^/]+/(${SOCRATA_ID})/?$`)];
/** Hosts that match a Socrata path shape without being Socrata. */
const NOT_SOCRATA = /(^|\.)(arcgis\.com|github\.com|huggingface\.co|zenodo\.org|doi\.org)$/;

/**
 * The machine-readable record of a dataset's licence, when its platform keeps one.
 * @param pageUrl - The dataset's landing page or a download URL.
 * @returns The platform and the URL of its licence record, or `undefined` when the URL is not a dataset of a platform this knows.
 */
export function licenceMetadata(pageUrl: string): LicenceMetadata | undefined {
  const { hostname, pathname } = new URL(pageUrl);
  if (!NOT_SOCRATA.test(hostname)) {
    for (const path of SOCRATA_PATHS) {
      const id = path.exec(pathname)?.[1];
      if (id !== undefined) {
        return { platform: "socrata", url: `https://${hostname}/api/views/${id}.json` };
      }
    }
  }
  const hub = /^\/datasets\/([0-9a-f]{32})/.exec(pathname)?.[1];
  if (hostname === "hub.arcgis.com" && hub !== undefined) {
    return { platform: "arcgis", url: `https://www.arcgis.com/sharing/rest/content/items/${hub}?f=json` };
  }
  const ckan = /^\/dataset\/([^/]+)/.exec(pathname)?.[1];
  if (ckan !== undefined && hostname.startsWith("ckan")) {
    return { platform: "ckan", url: `https://${hostname}/api/3/action/package_show?id=${ckan}` };
  }
  const github = /^\/([^/]+)\/([^/]+)\/?$/.exec(pathname);
  if (hostname === "github.com" && github !== null) {
    return { platform: "github", url: `https://api.github.com/repos/${github[1] ?? ""}/${github[2] ?? ""}/license` };
  }
  const huggingface = /^\/datasets\/([^/]+\/[^/]+)/.exec(pathname)?.[1];
  if (hostname === "huggingface.co" && huggingface !== undefined) {
    return { platform: "huggingface", url: `https://huggingface.co/api/datasets/${huggingface}` };
  }
  const zenodo = /^\/records?\/(\d+)/.exec(pathname)?.[1];
  if (hostname === "zenodo.org" && zenodo !== undefined) {
    return { platform: "zenodo", url: `https://zenodo.org/api/records/${zenodo}` };
  }

  return undefined;
}

/**
 * Refuses a curation that records a dataset on a machine-readable platform as stating no terms without having read the platform's licence record.
 * @param id - The entry id, for the message.
 * @param pageUrl - The dataset's landing page.
 * @param terms - What the curation records.
 * @throws When the terms state none and `readAt` lacks the platform's licence record.
 */
export function assertMachineReadableRead(id: string, pageUrl: string, terms: LicenceTerms): void {
  if ("licence" in terms) {
    return;
  }
  const metadata = licenceMetadata(pageUrl);
  if (metadata !== undefined && !terms.readAt.includes(metadata.url)) {
    throw new Error(`${id} is recorded without a licence, but ${metadata.platform} keeps each dataset's licence in a record the curation has not read: add ${metadata.url} to its readAt after reading it`);
  }
}
