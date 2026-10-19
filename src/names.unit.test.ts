import { describe, expect, it } from "vitest";
import { groupsOf, namesOf } from "./names";

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

  it("gives an alias that is a path its own address, not prefixed by the entry's namespace", () => {
    expect(namesOf({ id: "bar", namespace: ["home"], aliases: ["foo/graphs/bar"] })).toEqual({
      full: ["home/bar", "foo/graphs/bar"],
      all: ["bar", "home/bar", "graphs/bar", "foo/graphs/bar"],
    });
  });

  it("answers with a segment alias in the segment's place, for every combination of the namespace's segments", () => {
    const aliases = { suitesparse: ["ss", "sparse"], gset: ["g"] };
    const { full, all } = namesOf({ id: "g53", namespace: ["suitesparse", "gset"] }, aliases);
    expect(full).toEqual(["suitesparse/gset/g53"]);
    expect([...all].sort()).toEqual(["g/g53", "g53", "gset/g53", "sparse/g/g53", "sparse/gset/g53", "ss/g/g53", "ss/gset/g53", "suitesparse/g/g53", "suitesparse/gset/g53"]);
  });

  it("does not substitute into the name itself, and reads segment aliases only from their own keys", () => {
    expect(namesOf({ id: "ss", namespace: ["a"] }, { ss: ["x"] }).all).toEqual(["ss", "a/ss"]);
    expect(namesOf({ id: "c", namespace: ["constructor"] }, {}).all).toEqual(["c", "constructor/c"]);
  });
});

describe("groupsOf", () => {
  it("gives an entry with no namespace and no path aliases no groups", () => {
    expect(groupsOf({ id: "karate", aliases: ["club"] })).toEqual([]);
  });

  it("gives the home namespace once however many bare aliases there are", () => {
    expect(groupsOf({ id: "g53", namespace: ["suitesparse", "gset"], aliases: ["a", "b"] })).toEqual([["suitesparse", "gset"]]);
  });

  it("adds the group of each alias that is a path, each group once, after the home namespace", () => {
    expect(groupsOf({ id: "bar", namespace: ["home"], aliases: ["foo/graphs/bar", "foo/graphs/baz", "one/bar"] })).toEqual([["home"], ["foo", "graphs"], ["one"]]);
  });

  it("gives an entry whose only address is a path that group", () => {
    expect(groupsOf({ id: "bar", aliases: ["foo/bar"] })).toEqual([["foo"]]);
  });
});
