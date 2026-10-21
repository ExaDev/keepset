import { describe, expect, it } from "vitest";
import { MAX_CONSECUTIVE_UNRESOLVED } from "./archive";
import { type ChecksumPorts, checksumPins, type Read } from "./checksum";

const SHA256_DIGITS = 64;
const BYTES = 10;
const good = (digit: string): Read => ({ kind: "read", sha256: digit.repeat(SHA256_DIGITS), byteLength: BYTES });
const target = (name: string): { url: string; timestamp: string } => ({ url: `https://example.org/${name}`, timestamp: "20260101000000" });

function ports(answers: Readonly<Record<string, Read>>): { ports: ChecksumPorts; recorded: [string, string, string][]; read: string[] } {
  const recorded: [string, string, string][] = [];
  const read: string[] = [];

  return {
    read,
    recorded,
    ports: {
      read: async (url) => {
        read.push(url);

        return Promise.resolve(answers[url] ?? { kind: "failed", evidence: "HTTP 404" });
      },
      record: (url, timestamp, checksum) => {
        recorded.push([url, timestamp, checksum.sha256]);
      },
      log: () => undefined,
    },
  };
}

describe("checksumPins", () => {
  it("records the checksum of every snapshot it can read, in order, and lists the ones the archive does not serve", async () => {
    const world = ports({ "https://example.org/a": good("a"), "https://example.org/c": good("c") });
    const result = await checksumPins(world.ports, { targets: [target("a"), target("b"), target("c")], limit: undefined });
    expect(world.recorded.map(([url]) => url)).toEqual(["https://example.org/a", "https://example.org/c"]);
    expect(result).toMatchObject({ recorded: 2, stopped: undefined, unresolved: [] });
    expect(result.failed).toEqual([{ ...target("b"), evidence: "HTTP 404" }]);
  });

  it("stops at the limit, having recorded what it read", async () => {
    const world = ports({ "https://example.org/a": good("a"), "https://example.org/b": good("b") });
    const result = await checksumPins(world.ports, { targets: [target("a"), target("b")], limit: 1 });
    expect(world.read).toEqual(["https://example.org/a"]);
    expect(result.stopped).toMatch(/limit/);
  });

  it("stops when too many snapshots in a row could not be read, and a good read starts the count again", async () => {
    const names = Array.from({ length: MAX_CONSECUTIVE_UNRESOLVED + 2 }, (_, index) => `u${String(index)}`);
    const busy: Read = { kind: "busy", evidence: "HTTP 429" };
    const world = ports(Object.fromEntries(names.map((name) => [`https://example.org/${name}`, busy])));
    const result = await checksumPins(world.ports, { targets: names.map(target), limit: undefined });
    expect(world.read).toHaveLength(MAX_CONSECUTIVE_UNRESOLVED);
    expect(result.stopped).toMatch(/in a row/);
    expect(result.unresolved).toHaveLength(MAX_CONSECUTIVE_UNRESOLVED);

    const recovering = ports({ ...Object.fromEntries(names.slice(0, MAX_CONSECUTIVE_UNRESOLVED - 1).map((name) => [`https://example.org/${name}`, busy])), "https://example.org/ok": good("e") });
    const recovered = await checksumPins(recovering.ports, { targets: [...names.slice(0, MAX_CONSECUTIVE_UNRESOLVED - 1).map(target), target("ok"), ...names.slice(0, MAX_CONSECUTIVE_UNRESOLVED - 1).map(target)], limit: undefined });
    expect(recovered.stopped).toBeUndefined();
  });
});
