import { describe, expect, it } from "vitest";
import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import { COLLABORATION, LESMIS, RADOSLAW, UCSOCIAL, WIKISPEEDIA } from "../test-support/excerpts";
import { parseKonect } from "./konect";
import { parseNative } from "./parse-native";

type KonectParser = Extract<Parser, { format: "konect" }>;

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

const konect = (options: Readonly<Partial<KonectParser>> = {}): KonectParser => ({ format: "konect", encoding: "utf-8", weighted: false, timestamped: false, ...options });

function parseError(run: () => unknown): NativeParseError {
  try {
    run();
  } catch (error) {
    if (error instanceof NativeParseError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a NativeParseError");
}

describe("the konect parser", () => {
  it("reads a weighted network: the third column is each edge's weight, nodes are in first-appearance order", () => {
    expect(parseNative(utf8(LESMIS), konect({ weighted: true }))).toEqual({
      nodes: [{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }, { id: "5" }, { id: "6" }, { id: "7" }],
      edges: [
        { source: "1", target: "2", weight: 1 },
        { source: "2", target: "3", weight: 8 },
        { source: "2", target: "4", weight: 10 },
        { source: "2", target: "5", weight: 1 },
        { source: "2", target: "6", weight: 1 },
        { source: "2", target: "7", weight: 1 },
      ],
    });
  });

  it("keeps a bipartite network's two node sets apart, so left node 1 and right node 1 are two nodes", () => {
    expect(parseNative(utf8(COLLABORATION), konect())).toEqual({
      nodes: [{ id: "l:1" }, { id: "r:1" }, { id: "r:2" }, { id: "r:3" }, { id: "r:4" }],
      edges: [
        { source: "l:1", target: "r:1" },
        { source: "l:1", target: "r:2" },
        { source: "l:1", target: "r:3" },
        { source: "l:1", target: "r:4" },
      ],
    });
  });

  it("reads the time column as each edge's timestamp and leaves the repetition count out", () => {
    const graph = parseNative(utf8(UCSOCIAL), konect({ timestamped: true }));
    expect(graph.edges).toEqual([
      { source: "1", target: "2", timestamp: 1082008561 },
      { source: "3", target: "4", timestamp: 1082123439 },
      { source: "5", target: "2", timestamp: 1082381991 },
      { source: "6", target: "7", timestamp: 1082407219 },
      { source: "8", target: "7", timestamp: 1082407356 },
      { source: "9", target: "10", timestamp: 1082408003 },
    ]);
    expect(graph.nodes.map((node) => node.id)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
  });

  it("splits columns on any run of whitespace", () => {
    expect(parseNative(utf8(RADOSLAW), konect({ timestamped: true })).edges[0]).toEqual({ source: "1", target: "2", timestamp: 1262454010 });
  });

  it("reads tab-separated pairs when the file has no second line, with edges in file order", () => {
    expect(parseNative(utf8(WIKISPEEDIA), konect()).edges).toEqual([
      { source: "1", target: "2" },
      { source: "2", target: "3" },
      { source: "4", target: "5" },
      { source: "6", target: "7" },
    ]);
  });

  it("reads a weight and a time together, and a time that is a fraction", () => {
    const graph = parseNative(utf8("% sym weighted\n1 2 -0.5 1.5e9\n2 3 4 1500000000.25\n"), konect({ weighted: true, timestamped: true }));
    expect(graph.edges).toEqual([
      { source: "1", target: "2", weight: -0.5, timestamp: 1.5e9 },
      { source: "2", target: "3", weight: 4, timestamp: 1500000000.25 },
    ]);
  });

  it("reads the same graph however the text is split into pieces", () => {
    const whole = parseKonect([UCSOCIAL], konect({ timestamped: true }));
    for (let cut = 1; cut < UCSOCIAL.length; cut++) {
      expect(parseKonect([UCSOCIAL.slice(0, cut), UCSOCIAL.slice(cut)], konect({ timestamped: true }))).toEqual(whole);
    }
  });

  it("accepts an unweighted network whose lines carry a repetition count of 1", () => {
    expect(parseNative(utf8("% sym positive\n1 2 1\n2 3 1\n"), konect()).edges).toEqual([
      { source: "1", target: "2" },
      { source: "2", target: "3" },
    ]);
  });

  const refused: readonly { readonly name: string; readonly text: string; readonly options?: Partial<KonectParser>; readonly line: number; readonly message: RegExp }[] = [
    { name: "a file with no first line naming its format", text: "1 2\n", line: 1, message: /expected a first line "% FORMAT WEIGHTS"/ },
    { name: "an unknown network format", text: "% tri unweighted\n1 2\n", line: 1, message: /FORMAT one of sym, asym, bip/ },
    { name: "a dynamic network, whose third column is not a weight", text: "% asym dynamic\n1 2 1 5\n", options: { timestamped: true }, line: 1, message: /weight type "dynamic" is not one this parser reads/ },
    { name: "a weighted file read by a recipe that drops the weights", text: LESMIS, line: 1, message: /weight type is posweighted, so a recipe with weighted true reads it, not one with weighted false/ },
    { name: "an unweighted file read by a recipe that expects weights", text: WIKISPEEDIA, options: { weighted: true }, line: 1, message: /weight type is positive, so a recipe with weighted false/ },
    { name: "a file with a time column read by a recipe that drops it", text: UCSOCIAL, line: 3, message: /expected 2 or 3 columns for this recipe, found 4/ },
    { name: "a file without a time column read by a recipe that expects one", text: WIKISPEEDIA, options: { timestamped: true }, line: 2, message: /expected 4 columns for this recipe, found 2/ },
    { name: "a repetition count other than 1, which would be read as a single edge", text: "% sym positive\n1 2 3\n", line: 2, message: /third column "3" is not 1/ },
    { name: "a weight that is not a number", text: "% sym posweighted\n1 2 heavy\n", options: { weighted: true }, line: 2, message: /weight "heavy" is not a number/ },
    { name: "a time that is not a number", text: "% asym positive\n1 2 1 yesterday\n", options: { timestamped: true }, line: 2, message: /time "yesterday" is not a number/ },
    { name: "a node id of zero", text: "% sym unweighted\n0 1\n", line: 2, message: /"0" is not a node id from 1/ },
    { name: "a node id that is not an integer", text: "% sym unweighted\n1 b\n", line: 2, message: /"b" is not a node id/ },
    { name: "a right node id beyond the right set's declared size", text: "% bip unweighted\n% 2 5 3\n5 3\n1 4\n", line: 4, message: /"4" is not a node id from 1 to 3/ },
    { name: "a left node id beyond the left set's declared size", text: "% bip unweighted\n% 1 2 9\n3 1\n", line: 3, message: /"3" is not a node id from 1 to 2/ },
    { name: "an edge count that differs from the declared one", text: "% sym unweighted\n% 3 3 3\n1 2\n2 3\n", line: 4, message: /declares 3 edges, the file holds 2/ },
    { name: "a file with a first line and no edges", text: "% sym unweighted\n% 0 0 0\n", line: 2, message: /holds no edges/ },
    { name: "an empty file", text: "", line: 0, message: /no first line naming its format/ },
  ];
  it.each(refused)("fails loudly on $name", ({ text, options, line, message }) => {
    const error = parseError(() => parseNative(utf8(text), konect(options)));
    expect(error.line).toBe(line);
    expect(error.message).toMatch(message);
  });
});
