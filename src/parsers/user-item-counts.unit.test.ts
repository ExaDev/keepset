import { describe, expect, it } from "vitest";
import type { Parser } from "../entry";
import { LASTFM } from "../test-support/excerpts";
import { parseUserItemCounts } from "./user-item-counts";

const LISTENS: Extract<Parser, { format: "user-item-counts" }> = { format: "user-item-counts", encoding: "utf-8", delimiter: "tab", skipLines: 1, itemType: "artist" };

describe("parseUserItemCounts", () => {
  it("reads users and artists as two node sets and each count as the weight of a listened edge", () => {
    const graph = parseUserItemCounts([LASTFM], LISTENS);
    expect(graph.nodes).toEqual([
      { id: "u:2", type: "user" },
      { id: "a:51", type: "artist" },
      { id: "a:52", type: "artist" },
      { id: "a:53", type: "artist" },
    ]);
    expect(graph.edges[0]).toEqual({ source: "u:2", target: "a:51", type: "listened", weight: 13883 });
  });

  it("keeps a user and an artist the source numbers alike apart", () => {
    const graph = parseUserItemCounts(["userID\tartistID\tweight\r\n2\t2\t5\r\n"], LISTENS);
    expect(graph.nodes.map((node) => node.id)).toEqual(["u:2", "a:2"]);
  });

  it("refuses the header read as a count, a count that is not a positive whole number and a short line", () => {
    expect(() => parseUserItemCounts([LASTFM], { ...LISTENS, skipLines: 0 })).toThrow(/the count "weight" is not a positive whole number/);
    expect(() => parseUserItemCounts(["h\n2\t51\t0\n"], LISTENS)).toThrow(/the count "0"/);
    expect(() => parseUserItemCounts(["h\n2\t51\n"], LISTENS)).toThrow(/expected 3 fields/);
    expect(() => parseUserItemCounts(["h\n"], LISTENS)).toThrow(/holds no counts/);
  });
});
