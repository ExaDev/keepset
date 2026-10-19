import { CrosswalkSchema, validateCrosswalk, type Crosswalk } from "twindex";
import { z } from "zod";
import { kindOf } from "./categories";
import { define } from "./define";
import { EntrySchema, RelativePathSchema, toIssues, type Entry } from "./entry";
import { CatalogueSyntaxError, DatasetAmbiguousError, DatasetNotFoundError } from "./errors";
import { ManifestSchema, type Manifest } from "./manifest";
import { NAME_SEPARATOR, namesOf } from "./names";
import { getOwn } from "./own";
import { recordOf } from "./record";

/**
 * A catalogue index: the manifest, every entry, and every crosswalk file of the catalogue, keyed by its catalogue-relative path. The build assembles it from a catalogue directory; a consumer holding its own catalogue (a fork, say) can pass one to `createCatalogue`. Entry ids are unique, every fully qualified name (the whole namespace and an id or alias) identifies one entry and is not another entry's id, every crosswalk passes twindex's structural validation, every crosswalk file reference resolves, and every crosswalk's target is the category of each entry that uses it.
 */
export const CatalogueIndexSchema = define(
  z
    .object({
      manifest: ManifestSchema,
      crosswalks: recordOf(RelativePathSchema, CrosswalkSchema),
      entries: z.array(EntrySchema),
    })
    .strict()
    .superRefine((index, ctx) => {
      for (const [file, crosswalk] of Object.entries(index.crosswalks)) {
        for (const issue of validateCrosswalk(crosswalk)) {
          ctx.addIssue({ code: "custom", path: ["crosswalks", file], message: `rule ${String(issue.ruleIndex)}: ${issue.message}` });
        }
      }
      const seen = new Set<string>();
      const ids = new Set(index.entries.map((entry) => entry.id));
      const owners = new Map<string, string>();
      for (const [position, entry] of index.entries.entries()) {
        if (seen.has(entry.id)) {
          ctx.addIssue({ code: "custom", path: ["entries", position, "id"], message: `duplicate entry id ${entry.id}` });
        }
        seen.add(entry.id);
        for (const name of namesOf(entry).full) {
          const owner = owners.get(name);
          if (owner !== undefined && owner !== entry.id) {
            ctx.addIssue({ code: "custom", path: ["entries", position, "aliases"], message: `${name} already names entry ${owner}` });
          } else if (name !== entry.id && ids.has(name)) {
            // A lookup tries ids first, so an alias equal to another entry's id could never reach the entry that declares it.
            ctx.addIssue({ code: "custom", path: ["entries", position, "aliases"], message: `${name} is the id of another entry, which a lookup would reach instead` });
          }
          owners.set(name, owner ?? entry.id);
        }
        if (!("file" in entry.crosswalk)) {
          for (const issue of validateCrosswalk(entry.crosswalk)) {
            ctx.addIssue({ code: "custom", path: ["entries", position, "crosswalk"], message: `rule ${String(issue.ruleIndex)}: ${issue.message}` });
          }
        } else {
          const crosswalk = getOwn(index.crosswalks, entry.crosswalk.file);
          if (crosswalk === undefined) {
            ctx.addIssue({ code: "custom", path: ["entries", position, "crosswalk", "file"], message: `no crosswalk file ${entry.crosswalk.file} in the catalogue` });
          } else if (crosswalk.target !== entry.category) {
            ctx.addIssue({ code: "custom", path: ["entries", position, "crosswalk", "file"], message: `${entry.crosswalk.file} targets ${crosswalk.target}, not the entry's category ${entry.category}` });
          }
        }
      }
    }),
);
export type CatalogueIndex = z.infer<typeof CatalogueIndexSchema>;

/** One dataset as the library returns it: the entry (descriptor, sources, licence, citations and recipe), the kind of data its category holds, its crosswalk resolved from a file reference where it has one, and the catalogue it came from. */
export interface Dataset {
  readonly entry: Entry;
  readonly kind: string;
  readonly crosswalk: Crosswalk;
  readonly catalogue: Pick<Manifest, "id" | "version">;
}

/** Filters for `listDatasets`. Every filter given must match; none given lists everything. */
export interface DatasetQuery {
  /** The kind of data, such as `graph`: the part of the category id before the version. */
  readonly kind?: string;
  /** A category id, such as `graph/v1`. */
  readonly category?: string;
  /** The entry's domain, matched exactly. */
  readonly domain?: string;
  /** A namespace path such as `suitesparse` or `suitesparse/gset`: matches the entries in that namespace and every namespace beneath it. */
  readonly namespace?: string;
  /** Text that must appear, ignoring case, in the entry's id, an alias, its namespace, name, description, domain or one of its tags. */
  readonly text?: string;
}

/** A queryable catalogue: the surface `listDatasets` and `getDataset` are bound to. */
export interface Catalogue {
  readonly manifest: Manifest;
  /**
   * Lists the datasets matching a query, in entry id order.
   * @param query - The filters; all must match.
   * @returns The matching datasets.
   */
  readonly listDatasets: (query?: DatasetQuery) => Dataset[];
  /**
   * Returns one dataset by name. An entry's own id always resolves to it, ahead of any alias or shorter form; otherwise the name is an alias, or an id or alias with any trailing run of the entry's namespace before it (`b/c` or `a/b/c` for id `c` in namespace `a/b`), and resolves only when exactly one entry answers to it.
   * @param name - An entry id, alias or qualified name; untrusted, so lookup never reaches inherited properties.
   * @returns The dataset.
   * @throws DatasetAmbiguousError when more than one entry answers to the name and none has it as its id.
   * @throws DatasetNotFoundError when no entry answers to the name.
   */
  readonly getDataset: (name: string) => Dataset;
}

/**
 * Whether a dataset matches a query.
 * @param dataset - The dataset.
 * @param query - The filters.
 * @returns True when every given filter matches.
 */
function matches(dataset: Dataset, query: DatasetQuery): boolean {
  const { entry } = dataset;
  if (query.kind !== undefined && dataset.kind !== query.kind) {
    return false;
  }
  if (query.category !== undefined && entry.category !== query.category) {
    return false;
  }
  if (query.domain !== undefined && entry.domain !== query.domain) {
    return false;
  }
  if (query.namespace !== undefined) {
    const path = (entry.namespace ?? []).join(NAME_SEPARATOR);
    if (path !== query.namespace && !path.startsWith(`${query.namespace}${NAME_SEPARATOR}`)) {
      return false;
    }
  }
  if (query.text !== undefined) {
    const needle = query.text.toLowerCase();
    const haystack = [entry.id, ...(entry.aliases ?? []), (entry.namespace ?? []).join(NAME_SEPARATOR), entry.name, entry.description, entry.domain, ...entry.tags].filter((field): field is string => field !== undefined && field !== "");

    return haystack.some((field) => field.toLowerCase().includes(needle));
  }

  return true;
}

/**
 * Builds a queryable catalogue from an index. Pure and synchronous: no filesystem, no network, so it runs the same in a browser as in Node.
 * @param index - A candidate catalogue index.
 * @returns The catalogue.
 * @throws CatalogueSyntaxError carrying every issue when the index is not a valid catalogue.
 */
export function createCatalogue(index: unknown): Catalogue {
  const parsed = CatalogueIndexSchema.safeParse(index);
  if (!parsed.success) {
    throw new CatalogueSyntaxError("catalogue", toIssues(parsed.error));
  }
  const { manifest, crosswalks, entries } = parsed.data;
  const catalogue = { id: manifest.id, version: manifest.version };
  const datasets = new Map<string, Dataset>();
  // Every name an entry answers to, mapped to the ids of the entries that answer to it, in id order.
  const names = new Map<string, string[]>();
  for (const entry of [...entries].sort((left, right) => (left.id < right.id ? -1 : 1))) {
    // The schema's refinement has already proved every file reference resolves, so the throw below is unreachable for a parsed index; it narrows the lookup without an assertion.
    const crosswalk = "file" in entry.crosswalk ? getOwn(crosswalks, entry.crosswalk.file) : entry.crosswalk;
    if (crosswalk === undefined) {
      throw new CatalogueSyntaxError("catalogue", [{ path: `entries.${entry.id}.crosswalk.file`, message: "the crosswalk file does not resolve" }]);
    }
    datasets.set(entry.id, { entry, kind: kindOf(entry.category), crosswalk, catalogue });
    for (const name of new Set(namesOf(entry).all)) {
      names.set(name, [...(names.get(name) ?? []), entry.id]);
    }
  }

  return {
    manifest,
    listDatasets: (query = {}) => [...datasets.values()].filter((dataset) => matches(dataset, query)),
    getDataset: (name) => {
      const exact = datasets.get(name);
      if (exact !== undefined) {
        return exact;
      }
      const candidates = names.get(name) ?? [];
      const [only, ...others] = candidates;
      if (only === undefined) {
        throw new DatasetNotFoundError(name);
      }
      if (others.length > 0) {
        throw new DatasetAmbiguousError(name, candidates);
      }
      const dataset = datasets.get(only);
      if (dataset === undefined) {
        throw new DatasetNotFoundError(name);
      }

      return dataset;
    },
  };
}
