import { parseEntry } from "keepset";
import { describe, expect, it } from "vitest";
import { liveEntry, taskCollectionEntry } from "../src/test-support/entries";
import { dimensionsOf, formatBytes, formatCount } from "./dimensions";

const KARATE_NODES = 34;
const KARATE_EDGES = 78;
const KIBIBYTE = 1024;
const BYTES_IN_A_FILE = 2048;
const MILLIONS = 1_234_567;
const HALF_KIBIBYTE = 512;
const KIBIBYTE_AND_A_HALF = 1536;
const GIBIBYTE = KIBIBYTE * KIBIBYTE * KIBIBYTE;

describe("dimensionsOf", () => {
  it("reads the recorded counts, and a byte size only where it is not the placeholder zero", () => {
    expect(dimensionsOf(parseEntry({ ...liveEntry, properties: { rawBytes: BYTES_IN_A_FILE } }))).toEqual({ nodes: KARATE_NODES, edges: KARATE_EDGES, bytes: BYTES_IN_A_FILE });
    expect(dimensionsOf(parseEntry({ ...liveEntry, properties: { rawBytes: 0 } }))).not.toHaveProperty("bytes");
  });

  it("reads a collection's instance count", () => {
    expect(dimensionsOf(parseEntry(taskCollectionEntry))).toEqual({ instances: 2 });
  });

  it("leaves out what an entry does not record", () => {
    expect(dimensionsOf(parseEntry({ ...liveEntry, expectedCounts: {}, properties: {} }))).toEqual({});
  });
});

describe("formatCount and formatBytes", () => {
  it("groups digits and writes nothing for an unrecorded value", () => {
    expect(formatCount(MILLIONS)).toBe("1,234,567");
    expect(formatCount(undefined)).toBe("");
    expect(formatBytes(undefined)).toBe("");
  });

  it("uses the largest binary unit reached", () => {
    expect(formatBytes(HALF_KIBIBYTE)).toBe("512 B");
    expect(formatBytes(KIBIBYTE_AND_A_HALF)).toBe("1.5 KiB");
    expect(formatBytes(GIBIBYTE)).toBe("1 GiB");
  });
});
