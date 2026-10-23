import { describe, expect, it } from "vitest";
import { listingColumnWidths } from "./listing-columns";

const MILLIONS = 1_234_567;
const EDGES = 78;
const BYTES = 1536;
const COLUMNS = 9;
const NAME = 0;
const ID = 1;
const KIND = 2;
const DOMAIN = 3;
const NODES = 4;
const EDGES_COLUMN = 5;
const INSTANCES = 6;
const SIZE = 7;
/** Characters a header gains once sorted. */
const SORT_MARK = 2;

/** The character count a content column's width states. */
function charactersOf(width: string | undefined): number {
  const match = /^calc\((\d+)ch \+/.exec(width ?? "");

  return Number(match?.[1]);
}

describe("listingColumnWidths", () => {
  const widths = listingColumnWidths([
    { kind: "graph", nodes: MILLIONS, edges: EDGES },
    { kind: "tasks", bytes: BYTES },
  ]);

  it("gives every column a width, in column order", () => {
    expect(widths).toHaveLength(COLUMNS);
  });

  it("sizes each content column to the widest of its header, with a sort mark, and its values", () => {
    expect(charactersOf(widths[KIND])).toBe("Kind".length + SORT_MARK);
    // "1,234,567" is longer than "Nodes" and its mark; no row records an instance count, so the header decides.
    expect(charactersOf(widths[NODES])).toBe("1,234,567".length);
    expect(charactersOf(widths[EDGES_COLUMN])).toBe("Edges".length + SORT_MARK);
    expect(charactersOf(widths[INSTANCES])).toBe("Instances".length + SORT_MARK);
    expect(charactersOf(widths[SIZE])).toBe("1.5 KiB".length);
  });

  it("shares what the content columns leave among the text columns in proportion", () => {
    const text = [NAME, ID, DOMAIN, COLUMNS - 1].map((index) => widths[index] ?? "");
    expect(text.every((width) => width.startsWith("calc((max(100cqw, "))).toBe(true);
    expect(new Set(text).size).toBe(text.length);
  });

  it("takes the headers' widths where there are no rows", () => {
    expect(charactersOf(listingColumnWidths([])[NODES])).toBe("Nodes".length + SORT_MARK);
  });
});
