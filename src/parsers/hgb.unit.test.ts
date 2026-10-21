import { describe, expect, it } from "vitest";
import type { Parser } from "../entry";
import { DBLP_LINKS, DBLP_NODES, FREEBASE_LINKS, FREEBASE_NODES } from "../test-support/excerpts";
import { parseHgb } from "./hgb";

type HgbParser = Extract<Parser, { format: "hgb" }>;

/** Freebase's types as its info.dat gives them, down to the two link types the excerpt holds (codes 6 and 8). */
const FREEBASE: HgbParser = {
  format: "hgb",
  encoding: "utf-8",
  nodeTypes: ["BOOK", "FILM", "MUSIC", "SPORTS", "PEOPLE", "LOCATION", "ORGANIZATION", "BUSINESS"],
  linkTypes: [
    { name: "BOOK-and-BOOK", source: "BOOK", target: "BOOK" },
    { name: "BOOK-to-FILM", source: "BOOK", target: "FILM" },
    { name: "BOOK-on-SPORTS", source: "BOOK", target: "SPORTS" },
    { name: "BOOK-on-LOCATION", source: "BOOK", target: "LOCATION" },
    { name: "BOOK-about-ORGANIZATION", source: "BOOK", target: "ORGANIZATION" },
    { name: "FILM-and-FILM", source: "FILM", target: "FILM" },
    { name: "MUSIC-in-BOOK", source: "MUSIC", target: "BOOK" },
    { name: "MUSIC-in-FILM", source: "MUSIC", target: "FILM" },
    { name: "MUSIC-and-MUSIC", source: "MUSIC", target: "MUSIC" },
  ],
};

/** DBLP's types as its info.dat gives them. */
const DBLP: HgbParser = {
  format: "hgb",
  encoding: "utf-8",
  nodeTypes: ["author", "paper", "term", "venue"],
  linkTypes: [
    { name: "author-paper", source: "author", target: "paper" },
    { name: "paper-term", source: "paper", target: "term" },
    { name: "paper-venue", source: "paper", target: "venue" },
    { name: "paper-author", source: "paper", target: "author" },
    { name: "term-paper", source: "term", target: "paper" },
    { name: "venue-paper", source: "venue", target: "paper" },
  ],
};

const read = (nodes: string, links: string, options: HgbParser = FREEBASE): ReturnType<typeof parseHgb> => parseHgb({ nodes: [nodes], links: [links] }, options);

describe("parseHgb", () => {
  it("reads typed nodes in file order and typed links, a self loop included", () => {
    const graph = read(FREEBASE_NODES, FREEBASE_LINKS);
    expect(graph.nodes).toEqual([
      { id: "1749", type: "BOOK" },
      { id: "75175", type: "MUSIC" },
      { id: "77130", type: "MUSIC" },
      { id: "36362", type: "BOOK" },
    ]);
    expect(graph.edges).toEqual([
      { source: "75175", target: "75175", type: "MUSIC-and-MUSIC" },
      { source: "77130", target: "36362", type: "MUSIC-in-BOOK" },
      { source: "77130", target: "1749", type: "MUSIC-in-BOOK" },
    ]);
  });

  it("reads node lines with an attribute field and CRLF link lines, and keeps no name or attribute", () => {
    const graph = read(DBLP_NODES, DBLP_LINKS, DBLP);
    expect(graph.nodes).toEqual([
      { id: "262", type: "author" },
      { id: "4057", type: "paper" },
      { id: "18389", type: "term" },
      { id: "26108", type: "venue" },
    ]);
    expect(graph.edges.map((edge) => edge.type)).toEqual(["author-paper", "paper-author", "paper-term", "paper-venue", "term-paper", "venue-paper"]);
  });

  it("refuses a link whose endpoint is of another node type than its link type joins", () => {
    // Link type 7 is MUSIC-in-FILM; 36362 is a BOOK.
    expect(() => read(FREEBASE_NODES, "77130\t36362\t7\t1.0\n")).toThrow(/a MUSIC-in-FILM link's target must be a FILM node, and 36362 is a BOOK node/);
  });

  it("refuses a type code the recipe does not name, an endpoint that is no node, a repeated id and a weight other than 1", () => {
    expect(() => read(FREEBASE_NODES.replace("singer\t0", "singer\t8"), FREEBASE_LINKS)).toThrow(/node type "8" is not one of the 8/);
    expect(() => read(FREEBASE_NODES, "77130\t36362\t9\t1.0\n")).toThrow(/link type "9" is not one of the 9/);
    expect(() => read(FREEBASE_NODES, "77130\t99\t6\t1.0\n")).toThrow(/target "99" is not a node/);
    expect(() => read(`${FREEBASE_NODES}1749\tsinger\t0\n`, FREEBASE_LINKS)).toThrow(/node id 1749 is repeated/);
    expect(() => read(FREEBASE_NODES, "77130\t36362\t6\t0.5\n")).toThrow(/weight "0.5" is not 1/);
    expect(() => read(FREEBASE_NODES, "77130\t36362\t6\n")).toThrow(/expected 4 fields/);
    expect(() => read("1749\tsinger\n", FREEBASE_LINKS)).toThrow(/expected 3 or 4 fields/);
  });
});
