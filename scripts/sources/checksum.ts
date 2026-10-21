/* The `--checksum` pass of the archiver: reads the raw form of every pinned snapshot that records no checksum, and records the SHA-256 and length of the bytes it serves on every source that pins it. The bytes are read exactly as a fetch reads them, so the recorded hash is the one a fetch of the same snapshot computes. Everything outside reaches it through ports, so a unit test drives the pass with stand-ins. */

import { MAX_CONSECUTIVE_UNRESOLVED } from "./archive";
import type { Checksum } from "./entries";

/** What reading one snapshot's raw bytes came to. `busy` says nothing about the snapshot (the archive is throttling or failing, or the connection dropped), so it is read again on a later run. `failed` is the archive answering that it does not serve the snapshot. */
export type Read = ({ readonly kind: "read" } & Checksum) | { readonly kind: "busy"; readonly evidence: string } | { readonly kind: "failed"; readonly evidence: string };

/** Everything the pass touches outside itself. */
export interface ChecksumPorts {
  /** Reads a snapshot's raw bytes and digests them. */
  readonly read: (url: string, timestamp: string) => Promise<Read>;
  /** Records durably the checksum of the snapshot at that timestamp on every source that pins it. */
  readonly record: (url: string, timestamp: string, checksum: Checksum) => void;
  readonly log: (line: string) => void;
}

/** What one pass is asked to do. */
export interface ChecksumRequest {
  /** The pinned snapshots that record no checksum, in the order they are read. */
  readonly targets: readonly Target[];
  /** The most snapshots to read in this run; no bound when undefined. */
  readonly limit: number | undefined;
}

/** One pinned snapshot to read: the source URL and the pin's timestamp. */
interface Target {
  readonly url: string;
  readonly timestamp: string;
}

/** What a pass came to: how many checksums were recorded, the snapshots the archive does not serve, those it could not be asked about, and why the pass stopped early, if it did. */
export interface ChecksumResult {
  readonly recorded: number;
  readonly failed: readonly (Target & { readonly evidence: string })[];
  readonly unresolved: readonly string[];
  readonly stopped: string | undefined;
}

/**
 * Reads the snapshots in order, one at a time since the host pacing is shared, and records each checksum before going on, so a run cut short keeps what it read.
 * @param ports - What the pass touches outside itself.
 * @param request - The snapshots to read and the run's bound.
 * @returns What the pass came to.
 */
export async function checksumPins(ports: Readonly<ChecksumPorts>, request: Readonly<ChecksumRequest>): Promise<ChecksumResult> {
  const failed: (Target & { evidence: string })[] = [];
  const unresolved: string[] = [];
  let recorded = 0;
  let consecutive = 0;
  let stopped: string | undefined;

  /**
   * Applies one read to the pass's records.
   * @param target - The snapshot it belongs to.
   * @param outcome - What reading it came to.
   */
  const settle = (target: Target, outcome: Read): void => {
    if (outcome.kind === "read") {
      consecutive = 0;
      ports.record(target.url, target.timestamp, { sha256: outcome.sha256, byteLength: outcome.byteLength });
      recorded += 1;
      ports.log(`${target.url}: ${target.timestamp} is ${String(outcome.byteLength)} bytes, sha256 ${outcome.sha256}`);
    } else if (outcome.kind === "failed") {
      consecutive = 0;
      failed.push({ ...target, evidence: outcome.evidence });
      ports.log(`${target.url}: ${target.timestamp} is not served (${outcome.evidence})`);
    } else {
      consecutive += 1;
      unresolved.push(target.url);
      ports.log(`${target.url}: ${target.timestamp} could not be read (${outcome.evidence})`);
      if (consecutive >= MAX_CONSECUTIVE_UNRESOLVED) {
        stopped = "too many snapshots in a row could not be read";
      }
    }
  };

  /**
   * Works through the targets from an index on.
   * @param index - The target to work on.
   */
  const work = async (index: number): Promise<void> => {
    const target = request.targets[index];
    if (target === undefined || stopped !== undefined) {
      return;
    }
    if (request.limit !== undefined && index >= request.limit) {
      stopped = "the limit on snapshots for this run is reached";

      return;
    }
    settle(target, await ports.read(target.url, target.timestamp));

    return work(index + 1);
  };
  await work(0);

  return { recorded, failed, unresolved, stopped };
}
