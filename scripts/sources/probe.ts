/* One polite look at a source URL: does it still answer, and how large is it. Shared by the liveness check and the archiver, which both need to know whether a source resolves before they say anything about it. */

import { HTTP_STATUS } from "./http-status";
import { type PoliteClient, RequestFailure } from "./polite-client";

/** What a look at a URL found. `answered` carries the final status after redirects (any status, not only success), `unreachable` a connection that failed on every attempt with its error code when there was one. */
export type Probe =
  | { readonly kind: "answered"; readonly status: number; readonly contentLength: number | undefined; readonly finalUrl: string }
  | { readonly kind: "unreachable"; readonly code: string | undefined };

/** A request for the first byte only: enough to learn that a host serves the file and, from the `Content-Range` of the answer, how long it is. */
const FIRST_BYTE = "bytes=0-0";

/** Asks for the stored representation, so a length is the file's and not what a compressing proxy would send. */
const IDENTITY = "identity";

/**
 * The length a response states for the whole file: the total in a `Content-Range` (`bytes 0-0/1234`) when the answer is partial, otherwise `Content-Length`.
 * @param response - A HEAD answer or a ranged GET answer.
 * @returns The length in bytes, or undefined when the response states none or states it as `*`.
 */
export function statedLength(response: Pick<Response, "headers" | "status">): number | undefined {
  const raw = response.status === HTTP_STATUS.partialContent ? /\/(\d+)$/.exec(response.headers.get("content-range") ?? "")?.[1] : response.headers.get("content-length");

  return raw !== undefined && raw !== null && /^\d+$/.test(raw) ? Number(raw) : undefined;
}

/**
 * Looks at a URL: HEAD first, which costs the host no body, and when HEAD is refused or fails (many hosts answer HEAD with 403, 404 or 405 for a file they serve) a GET of the first byte. The second answer is the authoritative one.
 * @param client - The polite client.
 * @param url - The URL.
 * @returns What the host answered, or that it could not be reached.
 */
export async function probe(client: PoliteClient, url: string): Promise<Probe> {
  const headers = { "accept-encoding": IDENTITY };
  try {
    const head = await client.request(url, { method: "HEAD", headers });
    if (head.ok) {
      return { kind: "answered", status: head.status, contentLength: statedLength(head), finalUrl: head.url };
    }
  } catch (error) {
    if (!(error instanceof RequestFailure)) {
      throw error;
    }
  }
  try {
    const ranged = await client.request(url, { method: "GET", headers: { ...headers, range: FIRST_BYTE } });
    await ranged.body?.cancel();

    return { kind: "answered", status: ranged.status, contentLength: statedLength(ranged), finalUrl: ranged.url };
  } catch (error) {
    if (error instanceof RequestFailure) {
      return { kind: "unreachable", code: error.code };
    }
    throw error;
  }
}

/** Whether a failure code means the name or address is gone, or the host's certificate is wrong, for good: a host that does not resolve, refuses connections, or presents a certificate no client will accept. Anything else (a timeout, a reset) is the network's or the host's passing trouble. */
export function isDefinitiveFailure(code: string | undefined): boolean {
  return code !== undefined && (code === "ENOTFOUND" || code === "ECONNREFUSED" || /^(?:CERT_|ERR_TLS_CERT|DEPTH_ZERO|UNABLE_TO_|SELF_SIGNED)/.test(code));
}

/** The path segments that mark a site's own missing-page or error page: a host that answers a request for a file it no longer has with a redirect to such a page, itself a 200, has lost the file as surely as one that answers 404. */
const MISSING_PAGE_SEGMENTS: ReadonlySet<string> = new Set(["404", "not-found", "notfound", "not_found"]);

/**
 * Whether a request ended at a different URL whose path is a missing-page marker.
 * @param requested - The URL that was requested.
 * @param finalUrl - The URL the answer came from after redirects; empty when unknown.
 * @returns True when the host redirected the request to its own missing-page page.
 */
export function redirectsToMissingPage(requested: string, finalUrl: string): boolean {
  if (finalUrl === "" || finalUrl === requested) {
    return false;
  }

  return new URL(finalUrl).pathname.toLowerCase().split("/").some((segment) => MISSING_PAGE_SEGMENTS.has(segment));
}

/**
 * The observation a status rests on: the status, and where it came from when redirects led to another host, which is how a refusal by a storage bucket behind a site's download link shows up.
 * @param status - The final status.
 * @param requested - The URL that was requested.
 * @param finalUrl - The URL the answer came from; empty when unknown.
 * @returns For example `HTTP 403` or `HTTP 403 from sparse-files.example.edu`.
 */
export function statusEvidence(status: number, requested: string, finalUrl: string): string {
  const base = `HTTP ${String(status)}`;
  if (finalUrl === "") {
    return base;
  }
  const { host } = new URL(finalUrl);

  return host === new URL(requested).host ? base : `${base} from ${host}`;
}
