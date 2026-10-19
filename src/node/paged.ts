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

const LINE_FEED = 0x0a;
const QUOTE = 0x22;

/**
 * How many CSV records a response holds: the line feeds outside a quoted field, and one more when the last record has no line feed.
 * @param bytes - A CSV response.
 * @returns The number of records, the header included.
 */
function recordsIn(bytes: Uint8Array): number {
  let records = 0;
  let quoted = false;
  for (const byte of bytes) {
    if (byte === QUOTE) {
      quoted = !quoted;
    } else if (byte === LINE_FEED && !quoted) {
      records += 1;
    }
  }

  return bytes.length > 0 && bytes[bytes.length - 1] !== LINE_FEED ? records + 1 : records;
}

/**
 * Reads one response of a Socrata resource endpoint as bytes.
 * @param port - The network port.
 * @param url - The request URL.
 * @param signal - Aborts the request.
 * @returns The response body.
 * @throws KeepsetError when the server does not answer successfully.
 */
async function getBytes(port: FetchPort, url: string, signal: AbortSignal | undefined): Promise<Uint8Array> {
  const response = await port(url, signal === undefined ? {} : { signal });
  if (!response.ok) {
    throw new KeepsetError(`${url} answered ${String(response.status)} ${response.statusText}`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

/** What a Socrata read needs at every page: the resource's URL, how many rows a page holds, how many rows the resource has, and how to reach it. */
interface ResourceRead {
  readonly resource: string;
  readonly pageSize: number;
  readonly count: number;
  readonly port: FetchPort;
  readonly signal: AbortSignal | undefined;
}

/**
 * Reads a resource's pages, each starting where the rows held so far end, and checks each holds exactly the rows it should, so a response cut short is an error and not a table with rows missing.
 * @param read - The resource read.
 * @param held - The pages read so far, each after the first without its header record.
 * @param offset - How many rows the pages hold.
 * @returns Every page.
 * @throws KeepsetError when a page holds a different number of rows than the count says it should, or its header differs from the first page's.
 */
async function readResourcePages(read: Readonly<ResourceRead>, held: readonly Uint8Array[], offset: number): Promise<readonly Uint8Array[]> {
  if (offset >= read.count) {
    return held;
  }
  const page = await getBytes(read.port, `${read.resource}?%24order=%3Aid&%24limit=${String(read.pageSize)}&%24offset=${String(offset)}`, read.signal);
  const expected = Math.min(read.pageSize, read.count - offset);
  const rows = recordsIn(page) - 1;
  if (rows !== expected) {
    throw new KeepsetError(`${read.resource} gave ${String(rows)} rows at offset ${String(offset)} where ${String(expected)} of its ${String(read.count)} were due, so a response was cut short or the table changed during the download`);
  }
  const first = held[0];
  const headerEnd = page.indexOf(LINE_FEED) + 1;
  if (first !== undefined && !page.subarray(0, headerEnd).every((byte, index) => byte === first[index])) {
    throw new KeepsetError(`${read.resource} gave a different header at offset ${String(offset)} than at the start`);
  }

  return readResourcePages(read, [...held, first === undefined ? page : page.subarray(headerEnd)], offset + expected);
}

/**
 * Downloads a whole Socrata resource as one CSV: the row count is read first, then pages of `pageSize` rows in the order of the rows' ids, each checked to hold the rows it should, and joined under the first page's header.
 * @param resource - The resource's URL, such as `https://data.example.org/resource/abcd-1234.csv`, without a query.
 * @param pageSize - How many rows a page holds.
 * @param port - The network port.
 * @param signal - Aborts the download.
 * @returns The bytes of one CSV, which is what the parser reads and what the provenance hashes.
 * @throws KeepsetError when the resource does not report a count, or a page is not what it should be.
 */
async function downloadSocrataResource(resource: string, pageSize: number, port: FetchPort, signal: AbortSignal | undefined): Promise<Uint8Array> {
  const reported = /^"count"\r?\n"(\d+)"/.exec(new TextDecoder("utf-8").decode(await getBytes(port, `${resource}?%24select=count(*)`, signal)));
  if (reported?.[1] === undefined) {
    throw new KeepsetError(`${resource} did not report a row count`);
  }
  const pages = await readResourcePages({ resource, pageSize, count: Number(reported[1]), port, signal }, [], 0);
  if (pages.length === 0) {
    throw new KeepsetError(`${resource} has no rows`);
  }

  return Buffer.concat(pages);
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
  return paging.kind === "arcgis-query" ? downloadArcgisLayer(url, paging.orderBy, port, signal) : downloadSocrataResource(url, paging.pageSize, port, signal);
}
