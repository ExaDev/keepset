import { describe, expect, it } from "vitest";
import { namesOf } from "./names";

describe("namesOf", () => {
  it("gives an entry with no namespace and no aliases only its id", () => {
    expect(namesOf({ id: "karate" })).toEqual({ full: ["karate"], all: ["karate"] });
  });

  it("gives an entry in a namespace every trailing run of the namespace before its id", () => {
    expect(namesOf({ id: "c", namespace: ["a", "b"] })).toEqual({ full: ["a/b/c"], all: ["c", "b/c", "a/b/c"] });
  });

  it("gives each alias the same forms as the id, the id first", () => {
    expect(namesOf({ id: "ss-gset-g53", namespace: ["suitesparse", "gset"], aliases: ["g53"] })).toEqual({
      full: ["suitesparse/gset/ss-gset-g53", "suitesparse/gset/g53"],
      all: ["ss-gset-g53", "gset/ss-gset-g53", "suitesparse/gset/ss-gset-g53", "g53", "gset/g53", "suitesparse/gset/g53"],
    });
  });

  it("gives an alias of an entry with no namespace just the alias", () => {
    expect(namesOf({ id: "cora", aliases: ["planetoid-cora"] })).toEqual({ full: ["cora", "planetoid-cora"], all: ["cora", "planetoid-cora"] });
  });
});
