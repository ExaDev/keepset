/* The preview's worker: runs one dataset's recipe in this worker through keepset/browser, so the page stays responsive and the library's bytes stay out of the main bundle. The page sends `{ id }` (or `{ id, bytes }` when the visitor dropped the downloaded file for a source the page could not read), and this worker answers with the fetched result, a refusal naming the cross-origin block, or the error. */

import { captureRequestsFor, fetchDataset, RecipeError, requestCapture, UnreachableSourceError } from "keepset/browser";

/** What the page sends: the dataset id, and the file's bytes when the visitor dropped them for a source the page could not read. */
interface Request {
  readonly id: string;
  readonly bytes?: ArrayBuffer;
}

/** One answer this worker posts. */
type Answer =
  | { readonly kind: "done"; readonly data: unknown; readonly provenance: { readonly sha256: string; readonly byteLength: number } }
  | { readonly kind: "captured"; readonly requests: number }
  | { readonly kind: "unreadable" }
  | { readonly kind: "error"; readonly message: string };

/** Posts one answer to the page. */
const post = (answer: Answer): void => {
  self.postMessage(answer);
};

/**
 * Whether a failure is the page's reading of the source being refused, which a dropped file answers: no tier of the source's resolution chain got an HTTP answer (the host refuses cross-origin reads, or the network is unreachable) rather than the recipe failing.
 * @param error - What the fetch threw.
 * @returns True when the visitor's own download is the way past it.
 */
function isUnreadable(error: unknown): boolean {
  return error instanceof RecipeError && error.cause instanceof UnreachableSourceError;
}

/** The download fields a single-source provenance record carries, which are what a preview shows. */
function downloadOf(provenance: object): { readonly sha256: string; readonly byteLength: number } | undefined {
  if (!("sha256" in provenance) || !("byteLength" in provenance)) {
    return undefined;
  }
  const { sha256, byteLength } = provenance;
  if (typeof sha256 !== "string" || typeof byteLength !== "number") {
    return undefined;
  }

  return { sha256, byteLength };
}

/**
 * Runs one request and posts the answer, whatever it is.
 * @param request - The id and, for a dropped file, its bytes standing in for the source.
 */
async function run(request: Request): Promise<void> {
  const file = request.bytes === undefined ? undefined : new Uint8Array(request.bytes);
  try {
    const served = await fetchDataset(request.id, file === undefined ? {} : {
      fetch: async () => await Promise.resolve(new Response(file, { status: 200, headers: { "content-length": String(file.byteLength) } })),
    });
    const download = downloadOf(served.provenance);
    if (download === undefined) {
      post({ kind: "error", message: "the fetch recorded no download provenance" });

      return;
    }
    post({ kind: "done", data: served.data, provenance: download });
    // After the result is posted, so a capture never delays what the visitor came to see; a dropped file is the visitor's own copy, not a read of the live source, so it is never captured.
    const requests = file === undefined ? captureRequestsFor(served.provenance) : [];
    if (requests.length > 0) {
      await Promise.all(requests.map(async (saveUrl) => requestCapture(saveUrl)));
      post({ kind: "captured", requests: requests.length });
    }
  } catch (error: unknown) {
    if (file === undefined && isUnreadable(error)) {
      post({ kind: "unreadable" });

      return;
    }
    post({ kind: "error", message: error instanceof Error ? error.message : String(error) });
  }
}

self.onmessage = (event: MessageEvent<Request>): void => {
  void run(event.data);
};

export {};
