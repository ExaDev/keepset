import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { ArchiveError } from "../errors";
import { bzip2, gzip, tar, zip } from "../test-support/archives";
import { unpack, unpackMembers } from "./archive";
import { readTar } from "./tar";

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const names = (members: readonly { readonly path: string }[]): string[] => members.map((member) => member.path);

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

  it("unpacks a member that is an archive in its turn, naming the file by both paths (the GD 2004 contest bundle's GD04/challenge.zip)", () => {
    const bundle = zipSync({
      "GD04/challenge.zip": zip([
        { path: "challenge/prob1.gd4", text: "prob1" },
        { path: "challenge/prob10.gd4", text: "prob10" },
      ]),
      "GD04/sample1.gd4": new TextEncoder().encode("sample"),
      "GD04/gz/net.txt.gz": gzip("gunzipped"),
    });
    const inner = unpack(bundle, { kind: "zip", member: { extensions: [".zip"] }, inner: { kind: "zip", member: { path: "challenge/prob1.gd4" } } });
    expect(inner.member).toBe("GD04/challenge.zip/challenge/prob1.gd4");
    expect(text(inner.bytes)).toBe("prob1");
    const gunzipped = unpack(bundle, { kind: "zip", member: { extensions: [".gz"] }, inner: { kind: "gzip" } });
    expect([gunzipped.member, text(gunzipped.bytes)]).toEqual(["GD04/gz/net.txt.gz", "gunzipped"]);
    expect(() => unpack(bundle, { kind: "zip", member: { extensions: [".gd4"] }, inner: { kind: "zip", member: { path: "prob1.gd4" } } })).toThrow(ArchiveError);
    expect(() => unpack(bundle, { kind: "zip", member: { extensions: [".zip"] }, inner: { kind: "zip", member: { path: "challenge/prob2.gd4" } } })).toThrow(/found 0/);
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

describe("bzip2 archives", () => {
  const concat = (...parts: readonly Uint8Array[]): Uint8Array => Uint8Array.from(parts.flatMap((part) => [...part]));
  // Long enough to span several 100 kB bzip2 blocks, so a stream cut inside a block, between blocks and inside the trailer are all different faults.
  const REPEATS = 120_000;
  const long = "1 2 3\n".repeat(REPEATS);

  it("unpacks a bare bzip2 file", () => {
    expect(text(unpack(bzip2("1 2\n2 3\n"), { kind: "bzip2" }).bytes)).toBe("1 2\n2 3\n");
    expect(text(unpack(bzip2(long), { kind: "bzip2" }).bytes)).toBe(long);
  });

  it("unpacks the stream of an empty file to no bytes", () => {
    expect(unpack(bzip2(""), { kind: "bzip2" }).bytes).toHaveLength(0);
  });

  it("reads concatenated streams as one file, as bzip2 -d does", () => {
    expect(text(unpack(concat(bzip2("first\n"), bzip2("second\n")), { kind: "bzip2" }).bytes)).toBe("first\nsecond\n");
  });

  it("selects a tar.bz2 member by path, extension and pattern, and gives the same members as a tar.gz", () => {
    const files = [
      { path: "moreno_lesmis/out.moreno_lesmis_lesmis", text: "% sym posweighted\n1 2 1\n" },
      { path: "moreno_lesmis/meta.moreno_lesmis_lesmis", text: "name: Les Miserables\n" },
      { path: "moreno_lesmis/README.moreno_lesmis", text: "readme" },
    ];
    const archive = bzip2(tar(files));
    expect(unpack(archive, { kind: "tar.bz2", member: { path: "out.moreno_lesmis_lesmis" } }).member).toBe("moreno_lesmis/out.moreno_lesmis_lesmis");
    expect(unpack(archive, { kind: "tar.bz2", member: { pattern: "(?:[^/]+/)?out\\.[^/]+" } })).toEqual({ bytes: new TextEncoder().encode("% sym posweighted\n1 2 1\n"), member: "moreno_lesmis/out.moreno_lesmis_lesmis" });
    expect(names(unpackMembers(archive, { kind: "tar.bz2", members: { extensions: [".moreno_lesmis"] } }))).toEqual(["moreno_lesmis/README.moreno_lesmis"]);
    expect(names(unpackMembers(archive, { kind: "tar.bz2", members: { pattern: "moreno_lesmis/(?:meta|out)\\..*" } }))).toEqual(names(unpackMembers(gzip(tar(files)), { kind: "tar.gz", members: { pattern: "moreno_lesmis/(?:meta|out)\\..*" } })));
  });

  it("reads an archive written by the system tar and bzip2, not only by this suite's own writer", () => {
    const dir = mkdtempSync(join(tmpdir(), "keepset-tarbz2-"));
    try {
      mkdirSync(join(dir, "net"));
      writeFileSync(join(dir, "net", "out.net"), "% sym unweighted\n1 2\n");
      execFileSync("tar", ["-cjf", join(dir, "net.tar.bz2"), "-C", dir, "net"]);
      expect(text(unpack(readFileSync(join(dir, "net.tar.bz2")), { kind: "tar.bz2", member: { path: "out.net" } }).bytes)).toBe("% sym unweighted\n1 2\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const whole = bzip2(long);
  const flipped = Uint8Array.from(whole);
  const MIDDLE = Math.floor(whole.length / 2);
  // Any single flipped bit in the compressed data fails a block's CRC or the decoding that precedes it.
  const FLIPPED_BIT = 0b10000;
  flipped[MIDDLE] = (flipped[MIDDLE] ?? 0) ^ FLIPPED_BIT;
  const TRAILER_BYTES = 10;
  it.each([
    ["data that is not bzip2", new TextEncoder().encode("not bzip2 at all"), /does not start with the BZh header/],
    ["no data", new Uint8Array(0), /does not start with the BZh header/],
    ["a header with an impossible block size digit", new TextEncoder().encode("BZh0"), /does not start with the BZh header/],
    ["a stream cut inside a block", whole.subarray(0, MIDDLE), /./],
    ["a stream missing its end-of-stream trailer", whole.subarray(0, whole.length - TRAILER_BYTES), /input stream ended prematurely/],
    ["a corrupted block", flipped, /./],
    ["bytes after the last stream that are not another stream", concat(whole, new TextEncoder().encode("JUNKJUNKJUNK")), /./],
  ] as const)("rejects %s", (_name, bytes, message) => {
    for (const archive of [{ kind: "bzip2" }, { kind: "tar.bz2", member: { path: "a" } }] as const) {
      expect(() => unpack(bytes, archive)).toThrow(ArchiveError);
      expect(() => unpack(bytes, archive)).toThrow(/not valid bzip2 data/);
      expect(() => unpack(bytes, archive)).toThrow(message);
    }
  });
});

describe("unpackMembers", () => {
  const files = [
    { path: "suite/b.txt", text: "b" },
    { path: "suite/a.txt", text: "a" },
    { path: "suite/readme.md", text: "readme" },
    { path: "__MACOSX/suite/._a.txt", text: "fork" },
    { path: "suite/other/c.txt", text: "c" },
  ];

  it("gives every member an extension selector matches, in path order and without resource forks", () => {
    const members = unpackMembers(zip(files), { kind: "zip", members: { extensions: [".txt"] } });
    expect(names(members)).toEqual(["suite/a.txt", "suite/b.txt", "suite/other/c.txt"]);
    expect(members.map((member) => text(member.bytes))).toEqual(["a", "b", "c"]);
  });

  it("gives the same members from a tar and a tar.gz", () => {
    const archive = tar(files);
    expect(names(unpackMembers(archive, { kind: "tar", members: { extensions: [".txt"] } }))).toEqual(["suite/a.txt", "suite/b.txt", "suite/other/c.txt"]);
    expect(names(unpackMembers(gzip(archive), { kind: "tar.gz", members: { extensions: [".txt"] } }))).toEqual(["suite/a.txt", "suite/b.txt", "suite/other/c.txt"]);
  });

  it("takes a pattern selector as every member whose whole path matches it, so a readme and a solution beside the instances are left out", () => {
    const suite = zip([
      { path: "suite/Coordinates_2.txt", text: "two" },
      { path: "suite/Coordinates_10.txt", text: "ten" },
      { path: "suite/readme.txt", text: "readme" },
      { path: "suite/Coordinates_10.txt.bak", text: "backup" },
    ]);
    const members = { pattern: "suite/Coordinates_\\d+\\.txt" };
    expect(names(unpackMembers(suite, { kind: "zip", members }))).toEqual(["suite/Coordinates_10.txt", "suite/Coordinates_2.txt"]);
    expect(names(unpackMembers(tar([{ path: "a/x1.txt", text: "1" }, { path: "a/x2.md", text: "2" }]), { kind: "tar", members: { pattern: ".*\\.txt" } }))).toEqual(["a/x1.txt"]);
    expect(() => unpackMembers(suite, { kind: "zip", members: { pattern: "suite/Coordinates" } })).toThrow(/at least one member matching suite\/Coordinates, found none/);
    expect(unpack(suite, { kind: "zip", member: { pattern: "suite/readme\\.txt" } }).member).toBe("suite/readme.txt");
    expect(() => unpack(suite, { kind: "zip", member: { pattern: "suite/Coordinates_.*" } })).toThrow(/expected one member matching suite\/Coordinates_\.\*, found 3/);
  });

  it("takes a path selector as one member, matched by its trailing segments", () => {
    expect(names(unpackMembers(zip(files), { kind: "zip", members: { path: "b.txt" } }))).toEqual(["suite/b.txt"]);
  });

  it("rejects a selector that matches nothing, listing what the archive holds", () => {
    expect(() => unpackMembers(zip(files), { kind: "zip", members: { extensions: [".csv"] } })).toThrow(/at least one member ending \.csv, found none among: .*suite\/a\.txt/);
    expect(() => unpackMembers(zip(files), { kind: "zip", members: { path: "nope.txt" } })).toThrow(/at least one member nope\.txt/);
  });

  it("rejects bytes that are not the stated archive kind", () => {
    expect(() => unpackMembers(new TextEncoder().encode("not an archive"), { kind: "zip", members: { extensions: [".txt"] } })).toThrow(ArchiveError);
  });
});
