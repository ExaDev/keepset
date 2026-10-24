import { z } from "zod";

/* What Netzschleuder's own API says about a network beyond what the pipeline catalogue records: its tags, the first of which names the topic the network belongs to (Social, Biological, Transportation, Economic, Technological or Informational) and is the entry's domain. The API is the only place the collection states it, so it is read by probe-netzschleuder-index.ts and committed, and the import reads the committed copy and never the network. */

/** A network's landing page, `https://networks.skewed.de/net/<name>`. */
const NETWORK_URL = /^https:\/\/networks\.skewed\.de\/net\/([^/]+)$/;

/** The index: the day it was read and each network's tags in the order the API gives them. */
export const NetzschleuderIndexSchema = z
  .object({
    readOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: "must be a date, YYYY-MM-DD" }),
    networks: z.record(z.string().min(1), z.array(z.string().min(1)).min(1)),
  })
  .strict();
export type NetzschleuderIndex = z.infer<typeof NetzschleuderIndexSchema>;

/**
 * The name Netzschleuder gives a network.
 * @param url - A URL.
 * @returns The name when the URL is a network's landing page, otherwise undefined.
 */
export function networkName(url: string): string | undefined {
  return NETWORK_URL.exec(url)?.[1];
}

/**
 * The domain a network's tags give it, written as the catalogue writes the others.
 * @param tags - The network's tags, topic first.
 * @returns The topic with "network", such as "Social network".
 */
export function networkDomain(tags: readonly [string, ...string[]]): string {
  return `${tags[0]} network`;
}
