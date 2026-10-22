/* The browser's downloader: the platform `fetch` with a whole-request deadline, and no retry (see `downloadRaw`). One difference from the Node downloader is unavoidable and documented here rather than worked around: the platform undoes a `Content-Encoding: gzip` itself and the standard forbids asking it not to, so the bytes a gzip-labelled file arrives as are its decoded bytes, and the provenance hash is over those, not over the bytes as published. */

import { KeepsetError } from "../errors";

/** How long a request may take in all, at any point of a download, before it is given up as dead. The platform `fetch` reports progress to no one, so the stall watch of the Node downloader becomes a whole-request deadline here; a healthy server of the open data portals recipes read answers well inside it. */
export const STALL_MILLISECONDS = 120_000;

/** Options for one download: the signal that aborts it, and the deadline only a test shortens. */
export interface DownloadInit {
  readonly signal?: AbortSignal;
  readonly stallMilliseconds?: number;
}

/**
 * Downloads a URL's bytes, following redirects as the platform does, in one try. A browser cannot tell a host that refuses cross-origin reads from a dropped connection, since both reject with a TypeError, and a refusal is permanent, so a retry would only delay the offer of the file drop by the sum of its waits; the resolution chain's other tiers are the fallback, and the caller may ask again. See the module comment for the one difference from the Node downloader no browser can avoid.
 * @param url - An http or https URL.
 * @param init - The request options.
 * @returns A Response holding the bytes the platform delivers, with the final status.
 * @throws KeepsetError when the URL is not http or https, or the request passes its deadline; the platform's own failure when the connection fails.
 */
export async function downloadRaw(url: string, init: DownloadInit): Promise<Response> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new KeepsetError(`${url} is not an http or https URL`);
  }
  const deadline = new AbortController();
  const timer = setTimeout(() => {
    deadline.abort(new KeepsetError(`${url} did not finish within ${String(init.stallMilliseconds ?? STALL_MILLISECONDS)} milliseconds, so the request was given up as dead`));
  }, init.stallMilliseconds ?? STALL_MILLISECONDS);
  const abort = (): void => {
    deadline.abort(init.signal?.reason);
  };
  init.signal?.addEventListener("abort", abort, { once: true });
  try {
    return await fetch(url, { signal: deadline.signal, headers: { accept: "*/*" } });
  } catch (error) {
    if (init.signal?.aborted === true) {
      throw init.signal.reason;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", abort);
  }
}
