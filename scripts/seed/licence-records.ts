import type { LicencePlatform } from "./licence";

/* Reading the machine-readable licence record of a dataset on the platforms that keep one. The seed imports never fetch (their output is reproducible from committed files); `licence-audit.ts` fetches each record and uses this to decide whether the record states a licence, so curation that records a dataset as stating none can be checked against the platform's own record. */

/** What a platform's licence record says about a dataset. */
export interface LicenceReading {
  /** Whether the record names a licence or points at terms, however it names them. */
  readonly states: boolean;
  /** The licence as the record writes it, or why it states none. */
  readonly summary: string;
}

const NOT_STATED = "the record names no licence";
/** Hugging Face card values that name no licence: `other` says the card describes its own terms and `unknown` that it has none. */
const HUGGINGFACE_UNNAMED = new Set(["other", "unknown"]);
/** CKAN's licence ids for a dataset whose publisher gave none. */
const CKAN_UNSPECIFIED = new Set(["", "notspecified"]);

/**
 * The value at a key path of an unknown JSON value, when every step is an object.
 * @param value - The JSON value.
 * @param path - The keys to follow.
 * @returns The value there, or `undefined` when the path leaves the object.
 */
function at(value: unknown, ...path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null || !(key in current)) {
      return undefined;
    }
    const next: unknown = Reflect.get(current, key);
    current = next;
  }

  return current;
}

/**
 * Narrows to non-empty text.
 * @param value - The value to test.
 * @returns The text, or `undefined` when it is not a non-empty string.
 */
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * How each platform writes a dataset's licence in its record. A record type with no reader here does not compile.
 */
const READERS: Readonly<Record<LicencePlatform, (record: unknown) => LicenceReading>> = {
  socrata: (record) => {
    const license = at(record, "license");
    const name = text(at(license, "name")) ?? text(at(record, "licenseId"));
    if (name === undefined) {
      return { states: false, summary: NOT_STATED };
    }
    const terms = text(at(license, "termsLink"));

    return { states: true, summary: terms === undefined ? name : `${name} (${terms})` };
  },
  ckan: (record) => {
    const id = text(at(record, "result", "license_id"));
    const title = text(at(record, "result", "license_title"));
    if (id === undefined || CKAN_UNSPECIFIED.has(id)) {
      return { states: false, summary: title ?? NOT_STATED };
    }

    return { states: true, summary: `${title ?? id} (${id})` };
  },
  arcgis: (record) => {
    const plain = text(at(record, "licenseInfo"))?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

    return plain === undefined || plain === "" ? { states: false, summary: NOT_STATED } : { states: true, summary: plain };
  },
  github: (record) => {
    const spdx = text(at(record, "license", "spdx_id"));
    if (spdx === undefined || spdx === "NOASSERTION") {
      return { states: false, summary: record === undefined ? "the repository has no licence file" : NOT_STATED };
    }

    return { states: true, summary: spdx };
  },
  huggingface: (record) => {
    const license = at(record, "cardData", "license");
    const single = text(license);
    const declared = Array.isArray(license) ? license.filter((item): item is string => typeof item === "string") : single === undefined ? [] : [single];
    const names = declared.filter((name) => !HUGGINGFACE_UNNAMED.has(name));
    if (names.length === 0) {
      return { states: false, summary: declared.length === 0 ? NOT_STATED : `${declared.join(", ")} (names no licence)` };
    }

    return { states: true, summary: names.join(", ") };
  },
  zenodo: (record) => {
    const id = text(at(record, "metadata", "license", "id"));

    return id === undefined ? { states: false, summary: NOT_STATED } : { states: true, summary: id };
  },
};

/**
 * Reads a platform's licence record.
 * @param platform - The platform that produced the record.
 * @param record - The record parsed from JSON, or `undefined` when the platform answered that there is none (GitHub answers 404 for a repository without a licence file).
 * @returns Whether the record states a licence, and how it writes it.
 */
export function readLicenceRecord(platform: LicencePlatform, record: unknown): LicenceReading {
  return READERS[platform](record);
}
