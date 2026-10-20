import type { Crosswalk } from "crossmap";
import type { Entry } from "./entry";
import type { Manifest } from "./manifest";

/**
 * Copies a JSON value with every object's keys in ascending code-unit order, the order the house JSON lint (`json/sort-keys`) requires of committed JSON. `Object.fromEntries` defines each key as an own data property, so a key such as `__proto__` stays a key.
 * @param value - A JSON value.
 * @returns The same value with sorted keys.
 */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : 1))
        .map(([key, item]) => [key, sortKeys(item)]),
    );
  }

  return value;
}

/**
 * Serialises any JSON value in the committed form: two-space indented, keys in ascending order, with a trailing newline.
 * @param value - A JSON value.
 * @returns The file text.
 */
export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), undefined, 2)}\n`;
}

/**
 * Serialises a catalogue document (an entry, a manifest or a crosswalk file) as its file holds it: two-space indented JSON with keys in ascending order and a trailing newline. The form depends only on the document's content, so parsing a file written this way and serialising the result reproduces the file byte for byte.
 * @param doc - A parsed entry, manifest or crosswalk.
 * @returns The file text.
 */
export function serialise(doc: Entry | Manifest | Crosswalk): string {
  return canonicalJson(doc);
}
