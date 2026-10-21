import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("the browser bundle's platform neutrality", () => {
  it("imports no Node built-in", () => {
    const bundle = join(import.meta.dirname, "../../dist/browser/entry.js");
    expect(existsSync(bundle), `${bundle} is missing: build before the tests, as the pipeline does`).toBe(true);
    expect(readFileSync(bundle, "utf8")).not.toMatch(/from\s+["']node:|require\(["']node:/);
  });
});
