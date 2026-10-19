import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import canonicalize from "canonicalize";
import { describe, expect, it } from "vitest";
import { EntrySchema } from "../src/entry";
import { ManifestSchema } from "../src/manifest";
import { deadEntry, everyEntryShape, liveEntry, notFetchableEntry } from "../src/test-support/entries";

const repoRoot = join(import.meta.dirname, "..");

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function versionOf(packageJsonPath: string): string {
  const manifest = readJson(packageJsonPath);
  const version = isRecord(manifest) ? manifest["version"] : undefined;
  if (typeof version !== "string") {
    throw new Error(`${packageJsonPath} has no string version`);
  }

  return version;
}

/** Each generated schema, with its published file name. */
const files = ["entry.schema.json", "manifest.schema.json"].map((file) => ({ file, text: readFileSync(join(repoRoot, "schemas", file), "utf8") }));

/** An Ajv instance holding twindex's and trilean's published schemas from node_modules, so the external $refs resolve offline exactly as they would from the CDN. */
function validatorFor(file: string) {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  // trilean is twindex's dependency, not this package's, so it is found beside twindex's real directory rather than at the top of node_modules.
  const twindexDir = realpathSync(join(repoRoot, "node_modules/twindex"));
  for (const path of [join(twindexDir, "schemas/twindex.schema.json"), join(twindexDir, "../trilean/schemas/trilean.schema.json")]) {
    const schema = readJson(path);
    if (!isRecord(schema)) {
      throw new Error(`${path} is not a JSON object`);
    }
    ajv.addSchema(schema);
  }
  const schema = readJson(join(repoRoot, "schemas", file));
  if (!isRecord(schema)) {
    throw new Error(`${file} is not a JSON object`);
  }

  return ajv.compile(schema);
}

describe("the generated JSON Schemas", () => {
  it.each(files)("$file is exactly the RFC 8785 canonical form of its own content", ({ text }) => {
    expect(canonicalize(JSON.parse(text))).toBe(text);
  });

  it.each(files)("$file is pinned to this package's version", ({ file, text }) => {
    expect(JSON.parse(text)).toMatchObject({ $id: `https://cdn.jsdelivr.net/npm/keepset@${versionOf(join(repoRoot, "package.json"))}/schemas/${file}` });
  });

  it("refs twindex's published crosswalk schema at the installed version", () => {
    const [entry] = files;
    expect(JSON.parse(entry?.text ?? "null")).toMatchObject({
      $defs: { Crosswalk: { $ref: `https://cdn.jsdelivr.net/npm/twindex@${versionOf(join(repoRoot, "node_modules/twindex/package.json"))}/schemas/twindex.schema.json` } },
    });
  });

  it("agrees with the Zod entry schema on representative entries and rejections", () => {
    const validate = validatorFor("entry.schema.json");
    for (const doc of everyEntryShape) {
      expect(validate(doc)).toBe(true);
      expect(EntrySchema.is(doc)).toBe(true);
    }
    const rejected = [
      { ...liveEntry, category: "graph/v9" },
      { ...deadEntry, licence: { kind: "spdx" } },
      { ...notFetchableEntry, recipe: { status: "not-fetchable" } },
      { ...liveEntry, crosswalk: { ...liveEntry.crosswalk, rules: [{ op: "teleport", from: "a", to: "b" }] } },
    ];
    for (const doc of rejected) {
      expect(validate(doc)).toBe(false);
      expect(EntrySchema.is(doc)).toBe(false);
    }
  });

  it("agrees with the Zod manifest schema", () => {
    const validate = validatorFor("manifest.schema.json");
    const manifest = { id: "keepset-graphs", name: "keepset graphs", description: "Graphs.", version: "1.0.0", repository: "https://github.com/Mearman/keepset" };
    expect(validate(manifest)).toBe(true);
    expect(ManifestSchema.is(manifest)).toBe(true);
    expect(validate({ ...manifest, version: "1.0" })).toBe(false);
    expect(ManifestSchema.is({ ...manifest, version: "1.0" })).toBe(false);
  });
});
