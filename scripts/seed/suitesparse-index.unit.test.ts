import { describe, expect, it } from "vitest";
import { matrixKey, parseIndexKinds, SuiteSparseIndexSchema } from "./suitesparse-index";

/** A row of the collection's index page, in the markup the page writes. */
function row(group: string, name: string, kind: string): string {
  return `<tr>
<td class='column-id'>1</td>
<td class='column-name'><a href="/${group}/${name}">${name}</a></td>
<td class='column-group'><a href="/${group}">${group}</a></td>
<td class='column-num_rows'>1,138</td>
<td class='column-kind d-none d-md-table-cell'>${kind}</td>
<td class='column-date d-none d-md-table-cell'>1985</td>
</tr>`;
}

describe("parseIndexKinds", () => {
  it("reads each matrix's kind from the cells named by class", () => {
    const kinds = parseIndexKinds(`<table><tbody>${row("HB", "1138_bus", "Power Network Problem")}${row("Pajek", "Cities", "Weighted Graph")}</tbody></table>`);
    expect(Object.fromEntries(kinds)).toEqual({ "HB/1138_bus": "Power Network Problem", "Pajek/Cities": "Weighted Graph" });
  });

  it("restores the characters the page escapes and collapses its whitespace", () => {
    expect([...parseIndexKinds(row("G", "m", "Optimization &amp; Control\n  Problem")).values()]).toEqual(["Optimization & Control Problem"]);
  });

  it("keeps the first row of a matrix listed twice and skips a row with no kind", () => {
    const kinds = parseIndexKinds(`${row("G", "m", "First")}${row("G", "m", "Second")}${row("G", "blank", "")}`);
    expect(Object.fromEntries(kinds)).toEqual({ "G/m": "First" });
  });
});

describe("matrixKey", () => {
  it("names a Matrix Market download by its group and name", () => {
    expect(matrixKey("MM/HB/1138_bus.tar.gz")).toBe("HB/1138_bus");
  });

  it("names nothing else", () => {
    expect(matrixKey("RB/HB/1138_bus.tar.gz")).toBeUndefined();
    expect(matrixKey("MM/HB/1138_bus.mtx")).toBeUndefined();
  });
});

describe("SuiteSparseIndexSchema", () => {
  it("accepts a size only as a positive whole number of bytes", () => {
    expect(SuiteSparseIndexSchema.safeParse({ readOn: "2026-10-24", matrices: { "G/m": { kind: "k", downloadBytes: 1 } } }).success).toBe(true);
    expect(SuiteSparseIndexSchema.safeParse({ readOn: "2026-10-24", matrices: { "G/m": { kind: "k", downloadBytes: 0 } } }).success).toBe(false);
    expect(SuiteSparseIndexSchema.safeParse({ readOn: "2026-10-24", matrices: { "not-a-key": { kind: "k" } } }).success).toBe(false);
  });
});
