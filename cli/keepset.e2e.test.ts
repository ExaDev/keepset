// Runs the built command (dist-cli/keepset.mjs) as a child process, the way `npx keepset` does, so what is checked is the shipped file: its shebang, its imports of the library through the package's own name, and its exit status. package.json's bin must name that same file. No command here touches the network.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXIT_FAILED, EXIT_OK } from "./run";

const binPath = fileURLToPath(new URL("../dist-cli/keepset.mjs", import.meta.url));
const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));

/** What one child process may take: a node start and a bundle load, a second or two on an idle machine, with a wide margin for the shared machines this also runs on (load there has passed a hundred), since vitest's default limit assumes a test starts no processes. */
const SPAWN_BUDGET_MS = 15_000;

/** The most child processes any test below starts, which its limit is sized for. */
const MOST_SPAWNS_IN_A_TEST = 4;

function keepset(args: readonly string[]) {
  return spawnSync(process.execPath, [binPath, ...args], { encoding: "utf8" });
}

describe("the keepset command", { timeout: MOST_SPAWNS_IN_A_TEST * SPAWN_BUDGET_MS }, () => {
  it("is the file package.json's bin names, with a node shebang, and is not an export", () => {
    const manifest: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    expect(manifest).toMatchObject({ bin: { keepset: "./dist-cli/keepset.mjs" } });
    expect(JSON.stringify(manifest)).not.toMatch(/"exports":\{[^}]*dist-cli/);
    expect(readFileSync(binPath, "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
  });

  it("browses the bundled catalogue's namespaces, resolving a segment alias", () => {
    const roots = keepset(["namespaces"]);
    expect(roots.status).toBe(EXIT_OK);
    expect(roots.stdout).toMatch(/^suitesparse\t\d+$/m);
    const groups = keepset(["namespaces", "ss"]);
    expect(groups.status).toBe(EXIT_OK);
    expect(groups.stdout).toMatch(/^suitesparse\/gset\t\d+$/m);
    const missing = keepset(["namespaces", "nope"]);
    expect(missing.status).toBe(EXIT_FAILED);
    expect(missing.stderr).toContain('no namespace "nope"');
  });

  it("searches and shows the bundled catalogue", () => {
    const search = keepset(["search", "karate"]);
    expect(search.status).toBe(EXIT_OK);
    expect(search.stdout).toMatch(/^karate\tZachary's Karate Club\tgraph\/v1\tfetchable$/m);
    const show = keepset(["show", "karate", "--json"]);
    expect(show.status).toBe(EXIT_OK);
    expect(JSON.parse(show.stdout)).toMatchObject({ entry: { id: "karate" }, kind: "graph" });
    expect(keepset(["validate", "karate"]).stdout).toBe("karate is valid\n");
  });

  it("exits 2 with the library's message for an unknown dataset", () => {
    const result = keepset(["show", "no-such-entry"]);
    expect(result.status).toBe(EXIT_FAILED);
    expect(result.stderr).toBe('no dataset "no-such-entry" in the catalogue\n');
  });
});
