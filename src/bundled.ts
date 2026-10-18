import { createCatalogue, type Catalogue, type Dataset, type DatasetQuery } from "./catalogue";
import data from "./generated/catalogue.json" with { type: "json" };
import type { Manifest } from "./manifest";

let bundled: Catalogue | undefined;

/** The catalogue shipped in this package, assembled from catalogue/ by the build and parsed on first use, so importing the package costs nothing until a query runs. */
function catalogue(): Catalogue {
  bundled ??= createCatalogue(data);

  return bundled;
}

/**
 * Lists the datasets in the bundled catalogue that match a query. Browser-safe: a pure read over the index bundled with the package.
 * @param query - The filters; all must match, and none given lists everything.
 * @returns The matching datasets, in entry id order.
 */
export function listDatasets(query?: DatasetQuery): Dataset[] {
  return catalogue().listDatasets(query);
}

/**
 * Returns one dataset of the bundled catalogue: its entry (metadata and recipe) and its resolved crosswalk. Browser-safe.
 * @param id - The entry id.
 * @returns The dataset.
 * @throws DatasetNotFoundError when no entry has that id.
 */
export function getDataset(id: string): Dataset {
  return catalogue().getDataset(id);
}

/** @returns The bundled catalogue's manifest: its id, version and repository. */
export function getManifest(): Manifest {
  return catalogue().manifest;
}
