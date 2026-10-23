import { describe, expect, it } from "vitest";
import { propertyLabel, propertyText } from "./properties";

const DENSITY = 0.1408199643493761;
const COUNT = 1_234_567;
const KIBIBYTE_AND_A_HALF = 1536;

describe("propertyLabel", () => {
  it("writes a camel-case key as a sentence-case label", () => {
    expect(propertyLabel("edgeTypes")).toBe("Edge types");
    expect(propertyLabel("rawBytes")).toBe("Raw bytes");
    expect(propertyLabel("density")).toBe("Density");
  });
});

describe("propertyText", () => {
  it("writes a boolean as yes or no", () => {
    expect(propertyText("directed", true)).toEqual({ text: "yes" });
    expect(propertyText("directed", false)).toEqual({ text: "no" });
  });

  it("groups the digits of an integer", () => {
    expect(propertyText("components", 1)).toEqual({ text: "1" });
    expect(propertyText("edgeTypes", COUNT)).toEqual({ text: "1,234,567" });
  });

  it("shortens a fraction and keeps its exact value", () => {
    expect(propertyText("density", DENSITY)).toEqual({ text: "0.1408", exact: String(DENSITY) });
  });

  it("writes the byte-size key in its unit and keeps the exact byte count", () => {
    expect(propertyText("rawBytes", KIBIBYTE_AND_A_HALF)).toEqual({ text: "1.5 KiB", exact: "1,536 bytes" });
  });

  it("writes a string as it is and anything else as JSON", () => {
    expect(propertyText("source", "konect")).toEqual({ text: "konect" });
    expect(propertyText("labels", ["a", "b"])).toEqual({ text: '["a","b"]' });
  });
});
