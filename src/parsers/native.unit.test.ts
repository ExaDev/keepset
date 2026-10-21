import { describe, expect, it } from "vitest";
import { forEachLine } from "./native";

/** The lines forEachLine visits, with their numbers. */
function visited(pieces: readonly string[]): [string, number][] {
  const seen: [string, number][] = [];
  forEachLine(pieces, (line, number) => {
    seen.push([line, number]);
  });

  return seen;
}

describe("forEachLine", () => {
  const text = "1 2\r\n2 3\n\n3 1\r\nlast";
  const expected = ["1 2", "2 3", "", "3 1", "last"].map((line, index): [string, number] => [line, index + 1]);

  it("visits the same lines however the text is cut into pieces, a CRLF pair split between pieces included", () => {
    for (let cut = 0; cut <= text.length; cut += 1) {
      for (let second = cut; second <= text.length; second += 1) {
        expect(visited([text.slice(0, cut), text.slice(cut, second), text.slice(second)])).toEqual(expected);
      }
    }
  });

  it("visits no line for the empty text after a final terminator", () => {
    expect(visited(["a\r", "\n"])).toEqual([["a", 1]]);
    expect(visited([])).toEqual([]);
  });
});
