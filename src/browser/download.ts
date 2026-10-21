/* The browser's downloader: the platform `fetch` wrapped in the same retry policy as the Node one. One difference is unavoidable and documented here rather than worked around: the platform undoes a `Content-Encoding: gzip` itself and the standard forbids asking it not to, so the bytes a gzip-labelled file arrives as are its decoded bytes, and the provenance hash is over those, not over the bytes as published. */

import { KeepsetError } from "../errors";

/** How long a request may take in all, at any point of a download, before it is given up as dead. The platform `fetch` reports progress to no one, so the stall watch of the Node downloader becomes a whole-request deadline here; a healthy server of the open data portals recipes read answers well inside it. */
export const STALL_MILLISECONDS = 120_000;

/** How many times a download is tried when its connection fails, and how long each retry waits for the one before it (the delay times the attempt number), the policy the Node downloader keeps. */
export const DOWNLOAD_ATTEMPTS = 3;
export const RETRY_DELAY_MILLISECONDS = 3000;

/** Options for one download: the signal that aborts it, and the deadlines only a test shortens. */
export interface DownloadInit {
  readonly signal?: AbortSignal;
  readonly stallMilliseconds?: number;
  readonly retryDelayMilliseconds?: number;
}

/**
 * Downloads a URL's bytes, following redirects as the platform does. See the module comment for the one difference from the Node downloader no browser can avoid.
 * @param url - An http or https URL.
 * @param init - The request options.
 * @returns A Response holding the bytes the platform delivers, with the final status.
 * @throws KeepsetError when the URL is not http or https, or the request passes its deadline; the connection's failure, after the tries, when it keeps failing.
 */
export async function downloadRaw(url: string, init: DownloadInit): Promise<Response> {
  return await tryDownload(url, init, 1);
}

/**
 * One try of a download, and the tries after it while the connection fails.
 * @param url - The URL.
 * @param init - The request options.
 * @param attempt - Which try this is, from 1.
 * @returns The response.
 * @throws The last failure when the tries are used up, or at once for a failure that is not the connection's.
 */
async function tryDownload(url: string, init: DownloadInit, attempt: number): Promise<Response> {
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
    if (attempt >= DOWNLOAD_ATTEMPTS) {
      throw error;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, (init.retryDelayMilliseconds ?? RETRY_DELAY_MILLISECONDS) * attempt);
    });

    return await tryDownload(url, init, attempt + 1);
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", abort);
  }
}
