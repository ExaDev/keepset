import type { IncomingMessage } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { KeepsetError } from "../errors";

/** The most redirects one download follows: the Fetch Standard's own limit (https://fetch.spec.whatwg.org/#http-redirect-fetch, step 5). */
const MAX_REDIRECTS = 20;

/** The status codes that redirect, and so carry a `location` to follow (RFC 9110, section 15.4). */
const REDIRECT_STATUS = { movedPermanently: 301, found: 302, seeOther: 303, temporaryRedirect: 307, permanentRedirect: 308 } as const;
const REDIRECTS: ReadonlySet<number> = new Set(Object.values(REDIRECT_STATUS));

/** What the downloader says it is, so a server operator can tell where the traffic comes from. */
const USER_AGENT = "keepset (+https://github.com/ExaDev/keepset)";

/** Options for one download: the signal that aborts it. */
export interface DownloadInit {
  readonly signal?: AbortSignal;
}

/**
 * Sends one GET and resolves with the response head, its body still unread.
 * @param url - The URL.
 * @param signal - Aborts the request.
 * @returns The response.
 */
async function get(url: URL, signal: AbortSignal | undefined): Promise<IncomingMessage> {
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const request = send(url, { method: "GET", headers: { "user-agent": USER_AGENT }, ...(signal === undefined ? {} : { signal }) }, resolve);
    request.on("error", reject);
    request.end();
  });
}

/**
 * Reads a response body to the end.
 * @param response - The response.
 * @returns The body's bytes.
 */
async function readBody(response: IncomingMessage): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of response) {
    if (!(chunk instanceof Uint8Array)) {
      throw new KeepsetError("the response body yielded a chunk that is not bytes");
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

/**
 * Requests one URL, following its redirects by recursion.
 * @param url - The URL to request.
 * @param signal - Aborts the request.
 * @param redirects - How many redirects led here.
 * @returns The final response.
 */
async function follow(url: URL, signal: AbortSignal | undefined, redirects: number): Promise<Response> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new KeepsetError(`${url.href} is not an http or https URL`);
  }
  const response = await get(url, signal);
  const { statusCode: status, statusMessage } = response;
  // Node sets both on every response a client request receives; the types are optional only because IncomingMessage also models server-side requests.
  if (status === undefined || statusMessage === undefined) {
    throw new KeepsetError(`${url.href} answered without a status line`);
  }
  if (!REDIRECTS.has(status)) {
    return new Response(await readBody(response), { status, statusText: statusMessage });
  }
  response.resume();
  const { location } = response.headers;
  if (location === undefined) {
    throw new KeepsetError(`${url.href} answered ${String(status)} without a location`);
  }
  if (redirects === MAX_REDIRECTS) {
    throw new KeepsetError(`${url.href} redirected more than ${String(MAX_REDIRECTS)} times`);
  }

  return follow(new URL(location, url), signal, redirects + 1);
}

/**
 * Downloads a URL's bytes exactly as the server sends them, following redirects. Unlike the platform `fetch`, it never undoes a `Content-Encoding`: servers commonly label a `.gz` file `Content-Encoding: gzip`, and a recipe that unpacks gzip needs the file as published, which is also what its SHA-256 is recorded over. No `Accept-Encoding` is sent, so a server that compresses on the fly has no reason to.
 * @param url - An http or https URL.
 * @param init - The request options.
 * @returns A Response holding the raw bytes, with the final status.
 * @throws KeepsetError when a redirect has no location, leaves http and https, or passes the redirect limit.
 */
export async function downloadRaw(url: string, init: DownloadInit): Promise<Response> {
  return follow(new URL(url), init.signal, 0);
}
