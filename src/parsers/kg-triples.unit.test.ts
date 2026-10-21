import { describe, expect, it } from "vitest";
import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import { CODEX_S, FB15K_237_TRAIN, HETIONET, KINSHIP_TEST, KINSHIP_TRAIN, KINSHIP_VALID, NELL_995, WIKIKG2_TRAIN } from "../test-support/excerpts";
import { parseKgTriples } from "./kg-triples";

type TriplesParser = Extract<Parser, { format: "kg-triples" }>;

const PLAIN: TriplesParser = { format: "kg-triples", encoding: "utf-8", delimiter: "tab", order: "head-relation-tail", header: "none", quoted: false };

/** One unnamed file, as the fetch flow gives a recipe that reads a single file. */
const single = (text: string): { split: undefined; pieces: string[] }[] => [{ split: undefined, pieces: [text] }];

describe("parseKgTriples", () => {
  it("reads every split of a download into one graph, each edge typed by its relation and labelled with its split", () => {
    const graph = parseKgTriples(
      [
        { split: "train", pieces: [KINSHIP_TRAIN] },
        { split: "valid", pieces: [KINSHIP_VALID] },
        { split: "test", pieces: [KINSHIP_TEST] },
      ],
      PLAIN,
    );
    expect(graph.edges.slice(0, 2)).toEqual([
      { source: "person100", target: "person80", type: "term6", split: "train" },
      { source: "person37", target: "person72", type: "term10", split: "train" },
    ]);
    expect(graph.edges.map((edge) => ("split" in edge ? edge.split : undefined))).toEqual(["train", "train", "train", "train", "valid", "valid", "test", "test"]);
    // person39 first appears in the train split, so its second appearance in valid adds no node.
    expect(graph.nodes.map((node) => node.id)).toEqual(["person100", "person80", "person37", "person72", "person49", "person39", "person12", "person87", "person28", "person101", "person24", "person84", "person85", "person20", "person90"]);
  });

  it("gives a single file's edges no split", () => {
    const graph = parseKgTriples(single(CODEX_S), PLAIN);
    expect(graph.edges[0]).toEqual({ source: "Q7604", target: "Q188", type: "P1412" });
    expect(graph.edges.every((edge) => !("split" in edge))).toBe(true);
  });

  it("reads CRLF endings without carrying the carriage return into the tail", () => {
    const graph = parseKgTriples(single(FB15K_237_TRAIN), PLAIN);
    expect(graph.edges[0]).toEqual({ source: "/m/027rn", target: "/m/06cx9", type: "/location/country/form_of_government" });
    expect(graph.nodes.some((node) => node.id.includes("\r"))).toBe(false);
  });

  it("removes the quotes of a quoted file and refuses a quoted file read as unquoted fields that keep them", () => {
    const graph = parseKgTriples(single(WIKIKG2_TRAIN), { ...PLAIN, quoted: true });
    expect(graph.edges[0]).toEqual({ source: "Q8016027", target: "Q12177413", type: "P166" });
    expect(() => parseKgTriples(single(KINSHIP_TRAIN), { ...PLAIN, quoted: true })).toThrow(/not one value wrapped in double quotes/);
  });

  it("reads OpenKE id triples: the relation last, separated by spaces, after a count line it checks", () => {
    const options: TriplesParser = { ...PLAIN, delimiter: "space", order: "head-tail-relation", header: "count" };
    const graph = parseKgTriples(single(NELL_995), options);
    expect(graph.edges).toEqual([
      { source: "0", target: "1", type: "0" },
      { source: "2", target: "3", type: "1" },
      { source: "4", target: "3", type: "1" },
    ]);
    expect(() => parseKgTriples(single(NELL_995.replace(/^3/, "4")), options)).toThrow(/declares 4 triples, the file holds 3/);
    expect(() => parseKgTriples(single(NELL_995.replace(/^3/, "three")), options)).toThrow(/expected the number of triples/);
  });

  it("skips a header that names the columns, and reads it as an edge when told there is none", () => {
    const graph = parseKgTriples(single(HETIONET), { ...PLAIN, header: "names" });
    expect(graph.edges[0]).toEqual({ source: "Gene::9021", target: "Biological Process::GO:0071357", type: "GpBP" });
    expect(graph.nodes.some((node) => node.id === "source")).toBe(false);
    expect(parseKgTriples(single(HETIONET), PLAIN).edges[0]).toEqual({ source: "source", target: "target", type: "metaedge" });
  });

  it("refuses a line without three fields, an empty field, a blank line and a file with no triples, naming the split and line", () => {
    const fail = (text: string, split?: string): NativeParseError => {
      try {
        parseKgTriples([{ split, pieces: [text] }], PLAIN);
      } catch (error) {
        if (error instanceof NativeParseError) {
          return error;
        }
        throw error;
      }

      return expect.unreachable("the file was refused");
    };
    expect(fail("a\tb\n", "valid").message).toMatch(/valid: expected 3 fields separated by tab, found 2/);
    expect(fail("a\tb\tc\td\n").message).toMatch(/expected 3 fields/);
    expect(fail("a\t\tc\n").message).toMatch(/a field is empty/);
    expect(fail("a\tr\tb\n\nc\tr\td\n").line).toBe(2);
    expect(fail("").message).toMatch(/holds no triples/);
  });
});
