/* The `--verify` pass of the archiver: requests the raw snapshot of every pin already recorded, records the pins that serve their bytes, and removes the ones that do not from the live sources that hold them, so the next archiving run captures those URLs again. */

import { type ArchiveState, MAX_CONSECUTIVE_UNRESOLVED } from "./archive";
import type { SourceGroup } from "./entries";
import type { Clock } from "./pacing";
import type { PoliteClient } from "./polite-client";
import { verifyPin, type Verdict } from "./verify";

/** Everything the verification pass touches outside itself. */
export interface VerifyPorts {
  readonly client: PoliteClient;
  readonly clock: Clock;
  /** Removes the snapshot at that timestamp from every live source with that URL, durably. */
  readonly unpin: (url: string, timestamp: string) => void;
  /** Records durably that the pin served its bytes. */
  readonly verified: (url: string, timestamp: string) => void;
  /** Drops the record that the pin served its bytes, durably. */
  readonly unverified: (url: string, timestamp: string) => void;
  /** Stores the state durably. */
  readonly persist: (state: Readonly<ArchiveState>) => void;
  readonly log: (line: string) => void;
}

/** What one verification pass is asked to do. */
export interface VerifyRequest {
  readonly groups: readonly SourceGroup[];
  /** The pins the committed report already records as verified, as `pinKey` spells them. */
  readonly alreadyVerified: ReadonlySet<string>;
  /** Whether to request the pins the report already records as verified again. */
  readonly reverify: boolean;
  /** The entries to work on; every entry when undefined. */
  readonly entryIds: ReadonlySet<string> | undefined;
  /** The most pins to request in this run; no bound when undefined. */
  readonly limit: number | undefined;
  readonly state: ArchiveState;
}

/** One pin that did not serve its bytes, with what was observed. */
export interface FailedPin {
  readonly url: string;
  readonly timestamp: string;
  readonly evidence: string;
}

/**
 * What a pass came to. `removed` are the pins taken off live sources, to be captured again. `kept` are failing pins that only a `dead` source holds: the entry schema requires a dead source's snapshot and the source cannot be captured again, so the pin stays and a person must find another snapshot. `unresolved` could not be checked because the archive did not answer.
 */
export interface VerifyResult {
  readonly removed: FailedPin[];
  readonly kept: FailedPin[];
  readonly unresolved: string[];
  readonly stopped: string | undefined;
}

/** The key a pin is recorded under. */
export function pinKey(url: string, timestamp: string): string {
  return `${url}\n${timestamp}`;
}

/** One pin to look at, with what the catalogue records about its URL. */
interface Target {
  readonly url: string;
  readonly timestamp: string;
  readonly live: boolean;
  readonly dead: boolean;
}

/**
 * The pins of the groups in scope, in the groups' order.
 * @param request - The pass's request.
 * @returns One target per pin.
 */
function targetsOf(request: Readonly<VerifyRequest>): Target[] {
  return request.groups.flatMap((group) => (request.entryIds === undefined || group.entryIds.some((id) => request.entryIds?.has(id) === true) ? group.pins.map((pin) => ({ url: group.url, timestamp: pin.timestamp, live: group.live, dead: pin.dead })) : []));
}

/**
 * Requests the raw snapshot of every pin in scope, one at a time since the host pacing is shared, and settles each before going on.
 * @param ports - What the pass touches outside itself.
 * @param request - The catalogue's source groups, what is already verified and the run's bounds.
 * @returns The pins removed, the failing pins that had to stay, and those that could not be checked.
 */
export async function verifyPins(ports: Readonly<VerifyPorts>, request: Readonly<VerifyRequest>): Promise<VerifyResult> {
  const { client, clock, unpin, verified, unverified, persist, log } = ports;
  const state: ArchiveState = structuredClone(request.state);
  const targets = targetsOf(request).filter((target) => request.reverify || !request.alreadyVerified.has(pinKey(target.url, target.timestamp)));
  const removed: FailedPin[] = [];
  const kept: FailedPin[] = [];
  const unresolved: string[] = [];
  let settled = 0;
  let consecutive = 0;
  let stopped: string | undefined;

  /**
   * Applies one verdict to the pass's records.
   * @param target - The pin it belongs to.
   * @param verdict - What looking at the pin came to.
   */
  const settle = (target: Target, verdict: Verdict): void => {
    if (verdict.kind === "verified") {
      consecutive = 0;
      verified(target.url, target.timestamp);
      log(`${target.url}: ${target.timestamp} serves its bytes${verdict.notes.length === 0 ? "" : ` (the source has changed since: ${verdict.notes.join("; ")})`}`);
    } else if (verdict.kind === "busy") {
      consecutive += 1;
      unresolved.push(target.url);
      log(`${target.url}: ${target.timestamp} could not be checked (${verdict.evidence})`);
      if (consecutive >= MAX_CONSECUTIVE_UNRESOLVED) {
        stopped = "too many pins in a row could not be checked";
      }
    } else {
      consecutive = 0;
      unverified(target.url, target.timestamp);
      const failure: FailedPin = { url: target.url, timestamp: target.timestamp, evidence: verdict.evidence };
      if (target.dead) {
        kept.push(failure);
        log(`${target.url}: ${target.timestamp} does not serve its bytes and a dead source holds it, so it stays (${verdict.evidence})`);
      } else {
        unpin(target.url, target.timestamp);
        state.rejected[target.url] = [...(state.rejected[target.url] ?? []), target.timestamp];
        persist(structuredClone(state));
        removed.push(failure);
        log(`${target.url}: ${target.timestamp} does not serve its bytes and was removed (${verdict.evidence})`);
      }
    }
  };

  /**
   * Works through the targets from an index on.
   * @param index - The target to work on.
   */
  const work = async (index: number): Promise<void> => {
    const target = targets[index];
    if (target === undefined || stopped !== undefined) {
      return;
    }
    if (request.limit !== undefined && settled >= request.limit) {
      stopped = "the limit on pins for this run is reached";

      return;
    }
    settled += 1;
    // A pin recorded earlier is looked up once: waiting does not change what an old capture serves, and the source may have changed since, so a difference from it is noted and not held against the pin.
    settle(target, await verifyPin({ client, clock }, { url: target.url, timestamp: target.timestamp, live: target.live, compareStrictly: false }, 1));

    return work(index + 1);
  };
  await work(0);

  return { removed, kept, unresolved, stopped };
}
