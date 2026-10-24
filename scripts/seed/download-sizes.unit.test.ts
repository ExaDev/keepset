import { describe, expect, it } from "vitest";
import { downloadSize, DownloadSizesSchema, statedSize } from "./download-sizes";

const GZIP_SIZE = 4989;
const RAW_SIZE = 72_301;
const RECORDED_SIZE = 10;

describe("statedSize", () => {
  it("reads the size from Content-Length", () => {
    expect(statedSize(new Headers({ "content-length": String(GZIP_SIZE) }))).toBe(GZIP_SIZE);
  });

  it("reads the whole size from the total of a range response", () => {
    expect(statedSize(new Headers({ "content-range": `bytes 0-0/${String(RAW_SIZE)}`, "content-length": "1" }))).toBe(RAW_SIZE);
  });

  it("states no size for an empty, absent or unknown length", () => {
    expect(statedSize(new Headers({ "content-length": "0" }))).toBeUndefined();
    expect(statedSize(new Headers())).toBeUndefined();
    expect(statedSize(new Headers({ "content-range": "bytes 0-0/*" }))).toBeUndefined();
  });
});

describe("downloadSize", () => {
  const sizes = DownloadSizesSchema.parse({ readOn: "2026-10-24", sizes: { "https://example.org/a.zip": RECORDED_SIZE } });

  it("reads the size recorded for a URL and none for another", () => {
    expect(downloadSize(sizes, "https://example.org/a.zip")).toBe(RECORDED_SIZE);
    expect(downloadSize(sizes, "https://example.org/b.zip")).toBeUndefined();
    expect(downloadSize(sizes, "__proto__")).toBeUndefined();
  });

  it("accepts a size only as a positive whole number of bytes", () => {
    expect(DownloadSizesSchema.safeParse({ readOn: "2026-10-24", sizes: { "https://example.org/a.zip": 0 } }).success).toBe(false);
    expect(DownloadSizesSchema.safeParse({ readOn: "2026-10-24", sizes: { "https://example.org/a.zip": 1.5 } }).success).toBe(false);
  });
});
