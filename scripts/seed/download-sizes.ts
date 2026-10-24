import { z } from "zod";

/* The size of each download a recipe fetches, as the host serving it reports it. The source catalogue states a size for few datasets and states the raw data's, not the download's, so probe-download-sizes.ts asks each host and commits the answers, and the import reads the committed copy and never the network. */

/** The sizes: the day they were read and, for each download URL, its size in bytes. */
export const DownloadSizesSchema = z
  .object({
    readOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: "must be a date, YYYY-MM-DD" }),
    sizes: z.record(z.url(), z.int().positive()),
  })
  .strict();
export type DownloadSizes = z.infer<typeof DownloadSizesSchema>;

/**
 * The size of a download.
 * @param sizes - The committed sizes.
 * @param url - The download's URL.
 * @returns The size in bytes, or undefined when no host reported one.
 */
export function downloadSize(sizes: DownloadSizes, url: string): number | undefined {
  return Object.hasOwn(sizes.sizes, url) ? sizes.sizes[url] : undefined;
}

/**
 * The size a response states for the whole of its body: its Content-Length, or for a range response the total after the slash of its Content-Range.
 * @param headers - The response's headers.
 * @returns The size in bytes, or undefined when the response states none.
 */
export function statedSize(headers: Headers): number | undefined {
  const range = /^bytes \d+-\d+\/(\d+)$/.exec(headers.get("content-range") ?? "")?.[1];
  const length = range === undefined ? Number(headers.get("content-length")) : Number(range);

  return Number.isInteger(length) && length > 0 ? length : undefined;
}
