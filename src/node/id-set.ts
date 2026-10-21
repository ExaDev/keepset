import { KeepsetError } from "../errors";

/** The first table size, in slots: 2 to the 16th, a power of two, so a hash is reduced to a slot by masking (and every doubling keeps it one). */
const INITIAL_SLOTS = 65_536;

/** The first arena size, in bytes: a mebibyte, which a stream of a few tens of thousands of short ids fills before the arena first doubles. */
const INITIAL_ARENA_BYTES = 1_048_576;

/** The table grows when more than this share of its slots hold an id, which keeps linear probing short. */
const MAX_LOAD = 0.7;

/** The bytes before each id in the arena: its length, as an unsigned 32-bit integer. */
const LENGTH_BYTES = 4;

/** The largest arena, 2 to the 31st less one: slots hold an arena offset plus one in a signed 32-bit integer. */
const MAX_ARENA_BYTES = 2_147_483_647;

/** The FNV-1a 32-bit offset basis and prime (http://www.isthe.com/chongo/tech/comp/fnv/). */
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

const encoder = new TextEncoder();

/**
 * The FNV-1a hash of bytes.
 * @param bytes - The bytes.
 * @returns The 32-bit hash.
 */
function fnv1a(bytes: Uint8Array): number {
  let hash = FNV_OFFSET;
  for (const byte of bytes) {
    hash = Math.imul(hash ^ byte, FNV_PRIME);
  }

  return hash >>> 0;
}

/**
 * Reads a slot of a table.
 * @param slots - The table.
 * @param slot - A slot index, always masked into the table's range.
 * @returns What the slot holds.
 * @throws RangeError when the index is outside the table, which masking never gives.
 */
function slotOf(slots: Int32Array, slot: number): number {
  const held = slots[slot];
  if (held === undefined) {
    throw new RangeError(`slot ${String(slot)} is outside a table of ${String(slots.length)}`);
  }

  return held;
}

/**
 * A set of ids that holds each id as its UTF-8 bytes in one growing arena, indexed by an open-addressed table of arena offsets, so a stream of millions of ids is checked for repeats exactly while holding a few bytes beyond each id's own and no JavaScript string or object per id. Membership compares the bytes themselves, so two different ids are never taken for one.
 */
export class IdSet {
  private arena = new Uint8Array(INITIAL_ARENA_BYTES);

  private view = new DataView(this.arena.buffer);

  private used = 0;

  /** Each slot holds an id's arena offset plus one, or zero when empty. */
  private slots = new Int32Array(INITIAL_SLOTS);

  private count = 0;

  /** @returns How many ids the set holds. */
  public get size(): number {
    return this.count;
  }

  /**
   * Adds an id.
   * @param id - The id.
   * @returns True when the id was new, false when the set already held it.
   * @throws KeepsetError when the ids held would pass the largest arena.
   */
  public add(id: string): boolean {
    const bytes = encoder.encode(id);
    const hash = fnv1a(bytes);
    const mask = this.slots.length - 1;
    for (let slot = hash & mask; ; slot = (slot + 1) & mask) {
      const held = slotOf(this.slots, slot);
      if (held === 0) {
        this.slots[slot] = this.store(bytes) + 1;
        this.count += 1;
        if (this.count > this.slots.length * MAX_LOAD) {
          this.grow();
        }

        return true;
      }
      if (this.equals(held - 1, bytes)) {
        return false;
      }
    }
  }

  /**
   * Whether the id stored at an offset is these bytes.
   * @param offset - The id's arena offset.
   * @param bytes - The bytes.
   * @returns True when they are the same.
   */
  private equals(offset: number, bytes: Uint8Array): boolean {
    if (this.lengthAt(offset) !== bytes.length) {
      return false;
    }
    const start = offset + LENGTH_BYTES;

    return bytes.every((byte, index) => this.arena[start + index] === byte);
  }

  /**
   * The length of the id stored at an offset.
   * @param offset - The id's arena offset.
   * @returns Its byte length.
   */
  private lengthAt(offset: number): number {
    return this.view.getUint32(offset, true);
  }

  /**
   * Appends an id's bytes to the arena.
   * @param bytes - The bytes.
   * @returns Their offset.
   */
  private store(bytes: Uint8Array): number {
    const needed = this.used + LENGTH_BYTES + bytes.length;
    if (needed > MAX_ARENA_BYTES) {
      throw new KeepsetError(`the ids of the stream pass ${String(MAX_ARENA_BYTES)} bytes, more than one id set holds`);
    }
    if (needed > this.arena.length) {
      const grown = new Uint8Array(Math.min(MAX_ARENA_BYTES, Math.max(needed, this.arena.length * 2)));
      grown.set(this.arena.subarray(0, this.used));
      this.arena = grown;
      this.view = new DataView(grown.buffer);
    }
    const offset = this.used;
    this.view.setUint32(offset, bytes.length, true);
    this.arena.set(bytes, offset + LENGTH_BYTES);
    this.used = needed;

    return offset;
  }

  /** Doubles the table, placing every id again by its hash, which is recomputed from the arena so the table holds nothing but offsets. */
  private grow(): void {
    const slots = new Int32Array(this.slots.length * 2);
    const mask = slots.length - 1;
    for (const held of this.slots) {
      if (held !== 0) {
        const start = held - 1 + LENGTH_BYTES;
        let slot = fnv1a(this.arena.subarray(start, start + this.lengthAt(held - 1))) & mask;
        while (slotOf(slots, slot) !== 0) {
          slot = (slot + 1) & mask;
        }
        slots[slot] = held;
      }
    }
    this.slots = slots;
  }
}
