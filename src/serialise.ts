import type { Entry } from "./entry";
import type { Manifest } from "./manifest";

/**
 * Serialises a catalogue document as its file holds it: two-space indented JSON in the schema's key order with a trailing newline. A parsed document keeps the schema's key order, so parsing a file written this way and serialising the result reproduces the file byte for byte.
 * @param doc - A parsed entry or manifest.
 * @returns The file text.
 */
export function serialise(doc: Entry | Manifest): string {
  return `${JSON.stringify(doc, undefined, 2)}\n`;
}
