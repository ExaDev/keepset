import { matrixMarketPath, SUITESPARSE_ORIGIN, type SuiteSparseMirror } from "./mirror";
import { networkDomain, networkName, type NetzschleuderIndex } from "./netzschleuder-index";
import type { SourceDownload } from "./source";
import { matrixKey, type SuiteSparseIndex } from "./suitesparse-index";

/* What the collections' own indexes state of their datasets, which the source catalogue leaves unrecorded for most of them: the domain of a SuiteSparse matrix or a Netzschleuder network and the size of a SuiteSparse download. */

/** What the indexes of the collections the catalogue draws on state of their datasets. */
export interface SourceFacts {
  /** The kind and download size of each SuiteSparse matrix. */
  readonly suiteSparse: SuiteSparseIndex;
  /** The tags of each Netzschleuder network. */
  readonly netzschleuder: NetzschleuderIndex;
}

/**
 * The index's record of the SuiteSparse matrix a dataset downloads.
 * @param downloads - The dataset's downloads.
 * @param mirror - The SuiteSparse mirror, whose downloads are laid out as the collection's own.
 * @param index - What the SuiteSparse index states of each matrix.
 * @returns The record of the first download that is a SuiteSparse Matrix Market file the index lists, or undefined.
 */
function matrixOf(downloads: readonly SourceDownload[], mirror: SuiteSparseMirror, index: SuiteSparseIndex): SuiteSparseIndex["matrices"][string] | undefined {
  for (const { url } of downloads) {
    const path = url === undefined ? undefined : (matrixMarketPath(url, SUITESPARSE_ORIGIN) ?? matrixMarketPath(url, mirror.host));
    const key = path === undefined ? undefined : matrixKey(path);
    if (key !== undefined && Object.hasOwn(index.matrices, key)) {
      return index.matrices[key];
    }
  }

  return undefined;
}

/**
 * The domain a Netzschleuder network's tags give a dataset.
 * @param downloads - The dataset's downloads.
 * @param index - The tags of each Netzschleuder network.
 * @returns The domain of the first download that is a network the index lists, or undefined.
 */
function topicOf(downloads: readonly SourceDownload[], index: NetzschleuderIndex): string | undefined {
  for (const { url } of downloads) {
    const name = url === undefined ? undefined : networkName(url);
    const [first, ...rest] = name !== undefined && Object.hasOwn(index.networks, name) ? (index.networks[name] ?? []) : [];
    if (first !== undefined) {
      return networkDomain([first, ...rest]);
    }
  }

  return undefined;
}


/**
 * What the collections' indexes state of the dataset a set of downloads belongs to.
 * @param downloads - The dataset's downloads.
 * @param mirror - The SuiteSparse mirror, whose downloads are laid out as the collection's own.
 * @param facts - The collections' indexes.
 * @returns The domain a SuiteSparse matrix's kind or a Netzschleuder network's topic gives it, and the size of its SuiteSparse download, each present only where an index states it.
 */
export function factsOf(downloads: readonly SourceDownload[], mirror: SuiteSparseMirror, facts: SourceFacts): { readonly domain?: string; readonly downloadBytes?: number } {
  const matrix = matrixOf(downloads, mirror, facts.suiteSparse);
  const domain = matrix?.kind ?? topicOf(downloads, facts.netzschleuder);

  return { ...(domain === undefined ? {} : { domain }), ...(matrix?.downloadBytes === undefined ? {} : { downloadBytes: matrix.downloadBytes }) };
}
