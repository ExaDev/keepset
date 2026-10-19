import { z } from "zod";
import { KeepsetError } from "../errors";
import type { Paging } from "../entry";
import type { FetchPort } from "./fetch-dataset";

const countResponse = (value: unknown): number | undefined => (typeof value === "object" && value !== null && "count" in value && typeof value.count === "number" && Number.isInteger(value.count) && value.count >= 0 ? value.count : undefined);

/**
 * The error message an ArcGIS server returns in a 200 response, if the body is one.
 * @param value - A parsed response body.
 * @returns The message, or undefined when the body is not an error.
 */
function arcgisError(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("error" in value)) {
    return undefined;
  }
  const { error } = value;

  return typeof error === "object" && error !== null && "message" in error && typeof error.message === "string" ? error.message : "the server returned an error";
}

/**
 * Reads one JSON response of the layer's query endpoint.
 * @param port - The network port.
 * @param url - The request URL.
 * @param signal - Aborts the request.
 * @returns The parsed body.
 * @throws KeepsetError when the server does not answer successfully, the body is not JSON, or it is an ArcGIS error.
 */
async function getJson(port: FetchPort, url: string, signal: AbortSignal | undefined): Promise<unknown> {
  const response = await port(url, signal === undefined ? {} : { signal });
  if (!response.ok) {
    throw new KeepsetError(`${url} answered ${String(response.status)} ${response.statusText}`);
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8").decode(new Uint8Array(await response.arrayBuffer())));
  } catch (error) {
    throw new KeepsetError(`${url} did not answer JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  const message = arcgisError(body);
  if (message !== undefined) {
    throw new KeepsetError(`${url} answered an error: ${message}`);
  }

  return body;
}

/** What a layer read needs at every page: where the layer is, how its pages are ordered, how many features it holds, and how to reach it. */
interface LayerRead {
  readonly query: string;
  readonly orderBy: string;
  readonly count: number;
  readonly port: FetchPort;
  readonly signal: AbortSignal | undefined;
}

const FeatureListSchema = z.array(z.unknown());

/**
 * Reads a layer's features page by page, each request starting where the features held so far end.
 * @param layer - The layer read.
 * @param held - The features read so far.
 * @returns Every feature of the layer.
 * @throws KeepsetError when a page is empty before the count is reached or the server answers an error.
 */
async function readPages(layer: Readonly<LayerRead>, held: readonly unknown[]): Promise<readonly unknown[]> {
  if (held.length >= layer.count) {
    return held;
  }
  const url = `${layer.query}?where=1%3D1&outFields=*&orderByFields=${encodeURIComponent(layer.orderBy)}&resultOffset=${String(held.length)}&f=geojson`;
  const page = await getJson(layer.port, url, layer.signal);
  const features = FeatureListSchema.safeParse(typeof page === "object" && page !== null && "features" in page ? page.features : undefined);
  if (!features.success || features.data.length === 0) {
    throw new KeepsetError(`${layer.query} gave no features at offset ${String(held.length)}, before the ${String(layer.count)} it reports, so it does not page by offset`);
  }

  return readPages(layer, [...held, ...features.data]);
}

/**
 * Downloads a whole ArcGIS feature layer as one GeoJSON feature collection: the layer's feature count is read first, then its pages in `orderBy` order by offset until every feature is held, so a server that ignores the offset is an error and not an endless loop.
 * @param layerUrl - The layer's URL, such as `.../FeatureServer/0`.
 * @param orderBy - The field the pages are ordered by.
 * @param port - The network port.
 * @param signal - Aborts the download.
 * @returns The bytes of one `FeatureCollection`, which is what the parser reads and what the provenance hashes.
 * @throws KeepsetError when the layer does not report a count, a page is empty before the count is reached, or the server answers an error.
 */
async function downloadArcgisLayer(layerUrl: string, orderBy: string, port: FetchPort, signal: AbortSignal | undefined): Promise<Uint8Array> {
  const query = `${layerUrl.replace(/\/+$/, "")}/query`;
  const count = countResponse(await getJson(port, `${query}?where=1%3D1&returnCountOnly=true&f=json`, signal));
  if (count === undefined) {
    throw new KeepsetError(`${layerUrl} did not report a feature count`);
  }
  const pages = await readPages({ query, orderBy, count, port, signal }, []);

  return new TextEncoder().encode(JSON.stringify({ type: "FeatureCollection", features: pages }));
}

/**
 * Downloads a paged source as the one file its pages make, in the way its recipe's paging says.
 * @param url - The source's URL.
 * @param paging - How the source is paged.
 * @param port - The network port.
 * @param signal - Aborts the download.
 * @returns The bytes the parser reads.
 * @throws KeepsetError when a page cannot be read or the pages do not add up to what the source reports.
 */
export async function downloadPaged(url: string, paging: Readonly<Paging>, port: FetchPort, signal: AbortSignal | undefined): Promise<Uint8Array> {
  return downloadArcgisLayer(url, paging.orderBy, port, signal);
}
