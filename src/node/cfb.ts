import { ArchiveError } from "../errors";

/** The signature every Compound File Binary file opens with ([MS-CFB] 2.2), the bytes D0 CF 11 E0 A1 B1 1A E1 read as one little-endian 64-bit number. */
const SIGNATURE = 0xe1_1a_b1_a1_e0_11_cf_d0n;
const HEADER_BYTES = 512;
/** The sector numbers that mark the end of a chain and a free sector; every regular sector number is below the first of them ([MS-CFB] 2.1). */
const MAX_REGULAR_SECTOR = 0xff_ff_ff_fa;
const END_OF_CHAIN = 0xff_ff_ff_fe;
const FREE_SECTOR = 0xff_ff_ff_ff;
/** The sibling or child id that names no directory entry. */
const NO_STREAM = 0xff_ff_ff_ff;
/** The DIFAT entries the header holds before the first DIFAT sector. */
const HEADER_DIFAT_ENTRIES = 109;
const HEADER_DIFAT_OFFSET = 0x4c;
const DIRECTORY_ENTRY_BYTES = 128;
const DIRECTORY_NAME_BYTES = 64;
const ENTRY_BYTES = 4;
const STREAM_OBJECT = 2;
const ROOT_OBJECT = 5;
/** The header fields this reader uses, by byte offset ([MS-CFB] 2.2). */
const FIELD = {
  sectorShift: 0x1e,
  miniSectorShift: 0x20,
  fatSectors: 0x2c,
  firstDirectorySector: 0x30,
  miniStreamCutoff: 0x38,
  firstMiniFatSector: 0x3c,
  miniFatSectors: 0x40,
  firstDifatSector: 0x44,
  difatSectors: 0x48,
} as const;
/** The directory entry fields this reader uses, by byte offset within the entry ([MS-CFB] 2.6.1). */
const ENTRY = { nameLength: 0x40, type: 0x42, left: 0x44, right: 0x48, child: 0x4c, start: 0x74, size: 0x78 } as const;
/** The sector sizes the format allows, as their power of two: 512 bytes for a version 3 file, 4096 for version 4. */
const SECTOR_SHIFTS = { version3: 9, version4: 12 } as const;
const MINI_SECTOR_SHIFT = 6;

/** One directory entry: its name, its object type, its place in the red-black tree of its storage, and where its stream starts and how long it is. */
interface DirectoryEntry {
  readonly name: string;
  readonly type: number;
  readonly left: number;
  readonly right: number;
  readonly child: number;
  readonly start: number;
  readonly size: number;
}

/**
 * Reads a stream that lives at the root of a Compound File Binary file (the container of the legacy Office formats, an xls workbook among them), following its sector chain in the file allocation table, or in the mini stream when it is shorter than the file's cutoff.
 * @param bytes - The file.
 * @param name - The stream's name, compared without regard to case as the format compares names.
 * @returns The stream's bytes, or undefined when the root storage holds no stream of that name.
 * @throws ArchiveError when the bytes are not a compound file, or a header field, a sector chain or a directory entry is malformed.
 */
export function readRootStream(bytes: Uint8Array, name: string): Uint8Array | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < HEADER_BYTES || view.getBigUint64(0, true) !== SIGNATURE) {
    throw new ArchiveError("the file is not a compound file: it does not open with the compound file signature");
  }
  const u32 = (offset: number): number => view.getUint32(offset, true);
  const sectorShift = view.getUint16(FIELD.sectorShift, true);
  if ((sectorShift !== SECTOR_SHIFTS.version3 && sectorShift !== SECTOR_SHIFTS.version4) || view.getUint16(FIELD.miniSectorShift, true) !== MINI_SECTOR_SHIFT) {
    throw new ArchiveError(`the compound file states a sector size of 2^${String(sectorShift)} bytes, which the format does not allow`);
  }
  const sectorBytes = 2 ** sectorShift;
  const sectorCount = Math.floor((bytes.length - sectorBytes) / sectorBytes) + 1;
  const sector = (index: number): Uint8Array => {
    if (index >= MAX_REGULAR_SECTOR || index >= sectorCount) {
      throw new ArchiveError(`the compound file names sector ${String(index)}, which it does not have`);
    }
    const start = (index + 1) * sectorBytes;

    return bytes.subarray(start, Math.min(start + sectorBytes, bytes.length));
  };

  const fatSectors: number[] = [];
  for (let index = 0; index < HEADER_DIFAT_ENTRIES; index += 1) {
    fatSectors.push(u32(HEADER_DIFAT_OFFSET + index * ENTRY_BYTES));
  }
  const perDifatSector = sectorBytes / ENTRY_BYTES - 1;
  let difat = u32(FIELD.firstDifatSector);
  for (let read = 0; read < u32(FIELD.difatSectors); read += 1) {
    const difatSector = sector(difat);
    const entries = new DataView(difatSector.buffer, difatSector.byteOffset, difatSector.byteLength);
    for (let index = 0; index < perDifatSector; index += 1) {
      fatSectors.push(entries.getUint32(index * ENTRY_BYTES, true));
    }
    difat = entries.getUint32(perDifatSector * ENTRY_BYTES, true);
  }
  const fat = concatenateEntries(fatSectors.slice(0, u32(FIELD.fatSectors)).map(sector));
  const fatLimit = Math.min(fat.length, sectorCount);

  const chain = (start: number, table: Uint32Array, limit: number): number[] => {
    const sectors: number[] = [];
    let current = start;
    while (current !== END_OF_CHAIN) {
      const next = table[current];
      // A chain longer than the table has entries has met a sector twice, so it would never end.
      if (current >= limit || next === undefined || sectors.length >= limit) {
        throw new ArchiveError(`a sector chain of the compound file runs to ${current === FREE_SECTOR ? "a free sector" : `sector ${String(current)}`} instead of ending`);
      }
      sectors.push(current);
      current = next;
    }

    return sectors;
  };
  const regularStream = (start: number, size: number): Uint8Array => {
    const joined = concatenate(chain(start, fat, fatLimit).map(sector));
    if (joined.length < size) {
      throw new ArchiveError(`a stream of the compound file states ${String(size)} bytes but its sectors hold ${String(joined.length)}`);
    }

    return joined.subarray(0, size);
  };

  const directory = concatenate(chain(u32(FIELD.firstDirectorySector), fat, fatLimit).map(sector));
  const entry = (id: number): DirectoryEntry => {
    const offset = id * DIRECTORY_ENTRY_BYTES;
    if (offset + DIRECTORY_ENTRY_BYTES > directory.length) {
      throw new ArchiveError(`the compound file names directory entry ${String(id)}, which it does not have`);
    }
    const fields = new DataView(directory.buffer, directory.byteOffset + offset, DIRECTORY_ENTRY_BYTES);
    const nameLength = fields.getUint16(ENTRY.nameLength, true);
    if (nameLength > DIRECTORY_NAME_BYTES || nameLength % 2 !== 0) {
      throw new ArchiveError(`directory entry ${String(id)} of the compound file states a name of ${String(nameLength)} bytes`);
    }

    return {
      // The stored length counts the name's terminating null character, which is not part of the name.
      name: new TextDecoder("utf-16le").decode(directory.subarray(offset, offset + Math.max(0, nameLength - 2))),
      type: fields.getUint8(ENTRY.type),
      left: fields.getUint32(ENTRY.left, true),
      right: fields.getUint32(ENTRY.right, true),
      child: fields.getUint32(ENTRY.child, true),
      start: fields.getUint32(ENTRY.start, true),
      // A version 3 file may leave junk in the high half of the size, and no stream in a version 4 file this reader meets exceeds what the low half holds.
      size: fields.getUint32(ENTRY.size, true),
    };
  };
  const root = entry(0);
  if (root.type !== ROOT_OBJECT) {
    throw new ArchiveError("the first directory entry of the compound file is not its root storage");
  }

  const wanted = name.toUpperCase();
  const pending = root.child === NO_STREAM ? [] : [root.child];
  const visited = new Set<number>();
  let found: DirectoryEntry | undefined;
  while (pending.length > 0 && found === undefined) {
    const id = pending.pop();
    if (id === undefined || visited.has(id)) {
      throw new ArchiveError("the directory tree of the compound file has a cycle");
    }
    visited.add(id);
    const candidate = entry(id);
    if (candidate.type === STREAM_OBJECT && candidate.name.toUpperCase() === wanted) {
      found = candidate;
    }
    for (const sibling of [candidate.left, candidate.right]) {
      if (sibling !== NO_STREAM) {
        pending.push(sibling);
      }
    }
  }
  if (found === undefined) {
    return undefined;
  }
  if (found.size >= u32(FIELD.miniStreamCutoff)) {
    return regularStream(found.start, found.size);
  }

  const miniStream = regularStream(root.start, root.size);
  const miniFat = u32(FIELD.miniFatSectors) === 0 ? new Uint32Array() : concatenateEntries(chain(u32(FIELD.firstMiniFatSector), fat, fatLimit).map(sector));
  const miniBytes = 2 ** MINI_SECTOR_SHIFT;
  const joined = concatenate(
    chain(found.start, miniFat, Math.min(miniFat.length, Math.floor(miniStream.length / miniBytes))).map((index) => miniStream.subarray(index * miniBytes, (index + 1) * miniBytes)),
  );
  if (joined.length < found.size) {
    throw new ArchiveError(`a stream of the compound file states ${String(found.size)} bytes but its mini sectors hold ${String(joined.length)}`);
  }

  return joined.subarray(0, found.size);
}

/**
 * Joins byte runs.
 * @param parts - The runs, in order.
 * @returns One array holding them all.
 */
function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }

  return joined;
}

/**
 * Reads sectors of an allocation table as one list of little-endian 32-bit entries.
 * @param sectors - The table's sectors, in order.
 * @returns The entries.
 */
function concatenateEntries(sectors: readonly Uint8Array[]): Uint32Array {
  const joined = concatenate(sectors);
  const view = new DataView(joined.buffer, joined.byteOffset, joined.byteLength);

  return Uint32Array.from({ length: Math.floor(joined.length / ENTRY_BYTES) }, (_unused, index) => view.getUint32(index * ENTRY_BYTES, true));
}
