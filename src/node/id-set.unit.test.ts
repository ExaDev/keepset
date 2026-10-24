import { describe, expect, it } from "vitest";
import { IdSet } from "./id-set";

/** How many distinct ids the growth test adds: enough to double the table twice and the arena once from their first sizes. */
const COUNT = 100_000;
/** The ids differ in length as well as in digits, padded by up to this many characters less one. */
const PADDING = 7;
/** Every this many ids is added again, a sample across the whole range, each of which must be refused. */
const SAMPLE_STEP = 997;

/** Ids that differ from each other in one byte, in length, or only in how a character is composed (a precomposed e acute, and e followed by a combining acute), plus the empty id. */
const DISTINCT = ["a", "ab", "ba", "a\u0000", "\u00e9", "e\u0301", ""];

const idOf = (index: number): string => `id-${String(index)}-${"x".repeat(index % PADDING)}`;

describe("IdSet", () => {
  it("adds an id once and refuses it again, telling apart ids that differ in any byte or in length", () => {
    const ids = new IdSet();
    expect(DISTINCT.map((id) => ids.add(id))).toEqual(DISTINCT.map(() => true));
    expect(DISTINCT.map((id) => ids.add(id))).toEqual(DISTINCT.map(() => false));
    expect(ids.size).toBe(DISTINCT.length);
  });

  it("keeps every id through the table and the arena growing many times over", () => {
    const ids = new IdSet();
    // One assertion over the whole run: a hundred thousand `expect` calls cost far more than the set they check.
    const wronglyRefused: number[] = [];
    for (let index = 0; index < COUNT; index += 1) {
      if (!ids.add(idOf(index))) {
        wronglyRefused.push(index);
      }
    }
    const wronglyAccepted: number[] = [];
    for (let index = 0; index < COUNT; index += SAMPLE_STEP) {
      if (ids.add(idOf(index))) {
        wronglyAccepted.push(index);
      }
    }
    expect(wronglyRefused).toEqual([]);
    expect(wronglyAccepted).toEqual([]);
    expect(ids.add(idOf(COUNT))).toBe(true);
    expect(ids.size).toBe(COUNT + 1);
  });
});
