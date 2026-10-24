/* How an entry's recorded properties read on its page: a camel-case key as a sentence-case label, and a value as a person would write it, with the exact value kept in the cell's title. The properties of an entry are open-ended, so only a value's own type decides how it reads, apart from the one key the catalogue gives a unit. */

import { formatBytes, formatCount, isBytesProperty } from "./dimensions";

/** Significant digits a non-integer property is shown to; the cell's title carries every digit. */
const SIGNIFICANT_DIGITS = 4;

/** A property's value as the page shows it, with the exact value where the shown one is shortened. */
export interface PropertyText {
  readonly text: string;
  readonly exact?: string;
}

/**
 * Writes a property key as a label: the words of a camel-case key, the first capitalised.
 * @param key - The property key, such as `edgeTypes`.
 * @returns The label, such as "Edge types".
 */
export function propertyLabel(key: string): string {
  const words = key.replace(/([a-z\d])([A-Z])/g, "$1 $2").toLowerCase();

  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Writes a property value for reading: a boolean as yes or no, a count with its digits grouped, a byte size in its unit, a fraction to a few significant digits, and anything else as the JSON that records it.
 * @param key - The property key, which says whether a number is a byte size.
 * @param value - The recorded value.
 * @returns The text to show, and the exact value where the text is shortened.
 */
export function propertyText(key: string, value: unknown): PropertyText {
  if (typeof value === "boolean") {
    return { text: value ? "yes" : "no" };
  }
  if (typeof value === "number") {
    if (isBytesProperty(key)) {
      return { text: formatBytes(value), exact: `${formatCount(value)} bytes` };
    }
    if (Number.isInteger(value)) {
      return { text: formatCount(value) };
    }

    return { text: String(Number(value.toPrecision(SIGNIFICANT_DIGITS))), exact: String(value) };
  }
  if (typeof value === "string") {
    return { text: value };
  }

  return { text: JSON.stringify(value) };
}
