import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArchiveError } from "../errors";
import { gzip, tar, zip } from "../test-support/archives";
import { unpack } from "./archive";
import { readTar } from "./tar";

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe("readTar", () => {
  it("lists regular files with their full paths, skipping directories", () => {
    // Longer than the 100-byte ustar name field, so the writer emits a GNU long-name record.
    const segments = 30;
    const longPath = `${"deep/".repeat(segments)}file.mtx`;
    const members = readTar(
      tar([
        { path: "net/", text: "", type: "5" },
        { path: "net/net.mtx", text: "matrix" },
        { path: longPath, text: "long" },
      ]),
    );
    expect(members.map((member) => [member.path, text(member.data)])).toEqual([
      ["net/net.mtx", "matrix"],
      [longPath, "long"],
    ]);
  });

  it("reads an archive written by the system tar, not only by this suite's own writer", () => {
    const dir = mkdtempSync(join(tmpdir(), "keepset-tar-"));
    try {
      // Longer than the 100-byte ustar name field, so the system tar must use its long-path form.
      const repeats = 6;
      const longDir = "nested-directory-name-".repeat(repeats);
      mkdirSync(join(dir, "net", longDir), { recursive: true });
      writeFileSync(join(dir, "net", "net.mtx"), "matrix");
      writeFileSync(join(dir, "net", longDir, "deep.txt"), "deep");
      execFileSync("tar", ["-czf", join(dir, "net.tar.gz"), "-C", dir, "net"]);
      const unpacked = unpack(readFileSync(join(dir, "net.tar.gz")), { kind: "tar.gz", member: { extensions: [".txt"] } });
      expect(unpacked.member).toBe(`net/${longDir}/deep.txt`);
      expect(text(unpacked.bytes)).toBe("deep");
      expect(text(unpack(readFileSync(join(dir, "net.tar.gz")), { kind: "tar.gz", member: { path: "net.mtx" } }).bytes)).toBe("matrix");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a header whose checksum fails", () => {
    const bytes = tar([{ path: "a.txt", text: "a" }]);
    bytes[0] = 0x62;
    expect(() => readTar(bytes)).toThrow(ArchiveError);
  });

  it("rejects a member that runs past the end of the archive", () => {
    const block = 512;
    // Several blocks of data, cut off after the header and one block of it.
    const dataBlocks = 4;
    const bytes = tar([{ path: "a.txt", text: "x".repeat(block * dataBlocks) }]).subarray(0, block * 2);
    expect(() => readTar(bytes)).toThrow(/runs past the end/);
  });
});

describe("unpack", () => {
  it("passes plain bytes through and gunzips gzip", () => {
    expect(text(unpack(new TextEncoder().encode("plain"), { kind: "none" }).bytes)).toBe("plain");
    expect(text(unpack(gzip("zipped"), { kind: "gzip" }).bytes)).toBe("zipped");
  });

  it("selects a zip member by path, by trailing segments and by extension, ignoring resource forks", () => {
    const archive = zip([
      { path: "data/net.gml", text: "gml" },
      { path: "data/readme.txt", text: "readme" },
      { path: "__MACOSX/data/._net.gml", text: "fork" },
    ]);
    expect(unpack(archive, { kind: "zip", member: { path: "data/net.gml" } })).toEqual({ bytes: new TextEncoder().encode("gml"), member: "data/net.gml" });
    expect(unpack(archive, { kind: "zip", member: { path: "net.gml" } }).member).toBe("data/net.gml");
    expect(unpack(archive, { kind: "zip", member: { extensions: [".GML"] } }).member).toBe("data/net.gml");
  });

  it("selects a tar.gz member", () => {
    const archive = gzip(tar([{ path: "adjnoun/adjnoun.mtx", text: "mtx" }]));
    expect(unpack(archive, { kind: "tar.gz", member: { path: "adjnoun/adjnoun.mtx" } }).member).toBe("adjnoun/adjnoun.mtx");
    expect(text(unpack(tar([{ path: "a.net", text: "net" }]), { kind: "tar", member: { extensions: [".net"] } }).bytes)).toBe("net");
  });

  it("rejects a selector matching no member or several, listing what the archive holds", () => {
    const archive = zip([
      { path: "a.txt", text: "a" },
      { path: "b.txt", text: "b" },
    ]);
    expect(() => unpack(archive, { kind: "zip", member: { path: "c.txt" } })).toThrow(/found 0 among: a.txt, b.txt/);
    expect(() => unpack(archive, { kind: "zip", member: { extensions: [".txt"] } })).toThrow(/found 2/);
  });

  it("rejects bytes that are not the stated archive kind", () => {
    const notAnArchive = new TextEncoder().encode("not an archive at all");
    expect(() => unpack(notAnArchive, { kind: "gzip" })).toThrow(ArchiveError);
    expect(() => unpack(notAnArchive, { kind: "zip", member: { path: "a" } })).toThrow(ArchiveError);
  });
});
