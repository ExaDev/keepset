import { describe, expect, it } from "vitest";
import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import { AMAZON, ML_100K, ML_1M, ML_25M } from "../test-support/excerpts";
import { parseNative } from "./parse-native";
import { parseUserItemRatings } from "./user-item-ratings";

type RatingsParser = Extract<Parser, { format: "user-item-ratings" }>;

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

const ratings = (options: Readonly<Partial<RatingsParser>> = {}): RatingsParser => ({ format: "user-item-ratings", encoding: "utf-8", delimiter: "comma", skipLines: 0, itemType: "product", maxRating: 5, ...options });

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

/** 3.5 stars of 5. */
const HALF_STAR_WEIGHT = 0.7;

describe("the user-item-ratings parser", () => {
  it("reads an Amazon ratings file: comma separated, no header, nodes in first-appearance order typed user and product", () => {
    expect(parseNative(utf8(AMAZON), ratings())).toEqual({
      nodes: [
        { id: "u:A1YS9MDZP93857", type: "user" },
        { id: "p:0006428320", type: "product" },
        { id: "u:A3TS466QBAWB9D", type: "user" },
        { id: "p:0014072149", type: "product" },
        { id: "u:A3BUDYITWUSIS7", type: "user" },
        { id: "p:0041291905", type: "product" },
        { id: "u:A19K10Z0D2NTZK", type: "user" },
        { id: "p:0041913574", type: "product" },
        { id: "u:A14X336IB4JD89", type: "user" },
        { id: "p:0201891859", type: "product" },
      ],
      edges: [
        { source: "u:A1YS9MDZP93857", target: "p:0006428320", type: "rating", weight: 0.6, timestamp: 1394496000 },
        { source: "u:A3TS466QBAWB9D", target: "p:0014072149", type: "rating", weight: 1, timestamp: 1370476800 },
        { source: "u:A3BUDYITWUSIS7", target: "p:0041291905", type: "rating", weight: 1, timestamp: 1381708800 },
        { source: "u:A19K10Z0D2NTZK", target: "p:0041913574", type: "rating", weight: 1, timestamp: 1285200000 },
        { source: "u:A14X336IB4JD89", target: "p:0201891859", type: "rating", weight: 0.2, timestamp: 1350432000 },
      ],
    });
  });

  it("keeps the product id's leading zeros, because an id is text", () => {
    const { nodes } = parseNative(utf8(AMAZON), ratings());
    expect(nodes.map((node) => node.id)).toContain("p:0006428320");
  });

  it("reads ml-100k's u.data: tab separated, and user 1 and movie 1 are two nodes", () => {
    const graph = parseNative(utf8(ML_100K), ratings({ delimiter: "tab", itemType: "movie" }));
    expect(graph.nodes).toEqual([
      { id: "u:196", type: "user" },
      { id: "m:242", type: "movie" },
      { id: "u:186", type: "user" },
      { id: "m:302", type: "movie" },
      { id: "u:22", type: "user" },
      { id: "m:377", type: "movie" },
      { id: "u:1", type: "user" },
      { id: "m:1", type: "movie" },
    ]);
    expect(graph.edges.at(-1)).toEqual({ source: "u:1", target: "m:1", type: "rating", weight: 1, timestamp: 874965758 });
  });

  it("reads ml-1m's and ml-10m's ratings.dat: `::` between the fields", () => {
    const graph = parseNative(utf8(ML_1M), ratings({ delimiter: "double-colon", itemType: "movie" }));
    expect(graph.edges).toEqual([
      { source: "u:1", target: "m:1193", type: "rating", weight: 1, timestamp: 978300760 },
      { source: "u:1", target: "m:661", type: "rating", weight: 0.6, timestamp: 978302109 },
      { source: "u:1", target: "m:914", type: "rating", weight: 0.6, timestamp: 978301968 },
      { source: "u:1", target: "m:1", type: "rating", weight: 1, timestamp: 978824268 },
    ]);
    // The user is one node however many ratings name them, and movie 1 is not user 1.
    expect(graph.nodes.map((node) => node.id)).toEqual(["u:1", "m:1193", "m:661", "m:914", "m:1"]);
  });

  it("reads ml-25m's ratings.csv: the header line is skipped and half-star ratings keep their fraction", () => {
    const graph = parseNative(utf8(ML_25M), ratings({ delimiter: "comma", skipLines: 1, itemType: "movie" }));
    expect(graph.edges.map((edge) => ("weight" in edge ? edge.weight : undefined))).toEqual([1, HALF_STAR_WEIGHT, 1, 1]);
    expect(graph.nodes.map((node) => node.id)).toEqual(["u:1", "m:296", "m:306", "m:307", "m:665"]);
  });

  it("refuses the header line of ratings.csv when the recipe does not skip it, naming the line and the field", () => {
    const error = parseError(() => parseNative(utf8(ML_25M), ratings({ delimiter: "comma", itemType: "movie" })));
    expect(error.line).toBe(1);
    expect(error.message).toMatch(/rating "rating" is not a number above 0/);
  });

  it("divides by the recipe's maxRating, so the same ratings on a ten-point scale weigh half as much", () => {
    const edges = parseNative(utf8("u,i,5,1\n"), ratings({ maxRating: 10 })).edges;
    expect(edges).toEqual([{ source: "u:u", target: "p:i", type: "rating", weight: 0.5, timestamp: 1 }]);
  });

  it("accepts blank lines, and a final line with no terminator, among CRLF line endings", () => {
    const graph = parseNative(utf8("a,x,1,10\r\n\r\nb,y,5,20\r\n   \na,y,4,30"), ratings());
    expect(graph.edges.map((edge) => edge.source + edge.target)).toEqual(["u:ap:x", "u:bp:y", "u:ap:y"]);
  });

  it("counts skipped header lines in the line numbers it reports", () => {
    const error = parseError(() => parseNative(utf8("userId,movieId,rating,timestamp\n1,2,3\n"), ratings({ skipLines: 1 })));
    expect(error.line).toBe(2);
    expect(error.message).toMatch(/expected 4 fields/);
  });

  it("reads the same graph however the text is split into pieces, including between a carriage return and its line feed", () => {
    const text = "a,x,1,10\r\nb,y,5,20\r\nc,z,4,30\r\n";
    const whole = parseUserItemRatings([text], ratings());
    for (let cut = 1; cut < text.length; cut++) {
      expect(parseUserItemRatings([text.slice(0, cut), text.slice(cut)], ratings())).toEqual(whole);
    }
  });

  it("gives a repeated rating of the same pair two edges and one pair of nodes", () => {
    const graph = parseNative(utf8("a,x,1,10\na,x,5,20\n"), ratings());
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toHaveLength(2);
  });

  const refused: readonly { readonly name: string; readonly text: string; readonly options?: Partial<RatingsParser>; readonly line: number; readonly message: RegExp }[] = [
    { name: "a line with three fields", text: "a,x,5\n", line: 1, message: /expected 4 fields \(user, item, rating, timestamp\), found 3/ },
    { name: "a line with five fields", text: "a,x,5,1,9\n", line: 1, message: /found 5/ },
    { name: "a delimiter the file does not use", text: "a\tx\t5\t1\n", line: 1, message: /found 1/ },
    { name: "a rating above the scale", text: "a,x,5,1\nb,y,5.5,2\n", line: 2, message: /rating "5\.5" is not a number above 0 and at most 5/ },
    { name: "a rating of zero", text: "a,x,0,1\n", line: 1, message: /rating "0"/ },
    { name: "a negative rating", text: "a,x,-1,1\n", line: 1, message: /rating "-1"/ },
    { name: "a rating that is not a number", text: "a,x,five,1\n", line: 1, message: /rating "five"/ },
    { name: "a rating in exponent form", text: "a,x,5e0,1\n", line: 1, message: /rating "5e0"/ },
    { name: "a rating that is hexadecimal", text: "a,x,0x5,1\n", line: 1, message: /rating "0x5"/ },
    { name: "a timestamp that is not a whole number", text: "a,x,5,1.5\n", line: 1, message: /timestamp "1\.5" is not a whole number/ },
    { name: "an empty timestamp", text: "a,x,5,\n", line: 1, message: /timestamp ""/ },
    { name: "an empty user id", text: ",x,5,1\n", line: 1, message: /user id is empty/ },
    { name: "an empty item id", text: "a,,5,1\n", line: 1, message: /product id is empty/ },
    { name: "a file with no ratings", text: "\n\n", line: 2, message: /holds no ratings/ },
  ];
  it.each(refused)("fails loudly on $name", ({ text, options, line, message }) => {
    const error = parseError(() => parseNative(utf8(text), ratings(options)));
    expect(error.line).toBe(line);
    expect(error.message).toMatch(message);
  });
});
