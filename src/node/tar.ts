import { ArchiveError } from "../errors";

/** A tar archive is a sequence of 512-byte blocks: a header block, then the member's data padded to a whole number of blocks. */
export const BLOCK = 512;

/** The ustar header layout (POSIX.1-1988, pax(1) "ustar Interchange Format"): each field's byte offset and length. */
export const HEADER = {
  name: { offset: 0, length: 100 },
  mode: { offset: 100, length: 8 },
  size: { offset: 124, length: 12 },
  checksum: { offset: 148, length: 8 },
  type: { offset: 156, length: 1 },
  magic: { offset: 257, length: 6 },
  version: { offset: 263, length: 2 },
  prefix: { offset: 345, length: 155 },
} as const;

/** The byte the checksum field counts as while the checksum is computed: an ASCII space. */
export const CHECKSUM_FILL = 0x20;

/** GNU tar's base-256 numeric form: the high bit of a field's first byte flags it, and the remaining bits and bytes are a big-endian number. */
const BASE256_FLAG = 0x80;
const BASE256_FIRST_BITS = 0x7f;
const BYTE_RADIX = 256;

/** One regular file in a tar archive. */
export interface TarMember {
  readonly path: string;
  readonly data: Uint8Array;
}

/**
 * Reads a NUL-terminated (or field-filling) string from a header field.
 * @param bytes - The block.
 * @param offset - Field start.
 * @param length - Field length.
 * @returns The field text.
 */
function field(bytes: Uint8Array, offset: number, length: number): string {
  const slice = bytes.subarray(offset, offset + length);
  const end = slice.indexOf(0);

  return new TextDecoder().decode(end === -1 ? slice : slice.subarray(0, end));
}

/**
 * Reads a numeric header field: octal text, or for values too large for octal the GNU base-256 form, flagged by the high bit of the first byte.
 * @param bytes - The block.
 * @param offset - Field start.
 * @param length - Field length.
 * @returns The number.
 */
function numeric(bytes: Uint8Array, offset: number, length: number): number {
  const first = bytes[offset];
  if (first !== undefined && (first & BASE256_FLAG) !== 0) {
    let value = first & BASE256_FIRST_BITS;
    for (const byte of bytes.subarray(offset + 1, offset + length)) {
      value = value * BYTE_RADIX + byte;
    }

    return value;
  }
  const text = field(bytes, offset, length).trim();
  if (!/^[0-7]*$/.test(text)) {
    throw new ArchiveError(`tar header field is not octal: ${JSON.stringify(text)}`);
  }

  return text === "" ? 0 : Number.parseInt(text, 8);
}

/**
 * Reads the `path` record of a pax extended header (POSIX.1-2001): records are `<length> <key>=<value>\n`.
 * @param data - The extended header's data.
 * @returns The path it sets, if it sets one.
 */
function paxPath(data: Uint8Array): string | undefined {
  const text = new TextDecoder().decode(data);
  let path: string | undefined;
  for (const record of text.split("\n")) {
    const match = /^\d+ path=(.*)$/s.exec(record);
    if (match?.[1] !== undefined) {
      path = match[1];
    }
  }

  return path;
}

/**
 * Lists the regular files of a tar archive (ustar, with GNU long names and pax path records), verifying each header's checksum.
 * @param bytes - The archive.
 * @returns Every regular file, with its full path.
 * @throws ArchiveError when a header checksum fails or a member runs past the end of the archive.
 */
export function readTar(bytes: Uint8Array): TarMember[] {
  const members: TarMember[] = [];
  let longName: string | undefined;
  let offset = 0;
  while (offset + BLOCK <= bytes.length) {
    const header = bytes.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    // The checksum is the sum of the header's bytes with its own field counted as spaces.
    const { checksum } = HEADER;
    let sum = 0;
    for (const [index, byte] of header.entries()) {
      sum += index >= checksum.offset && index < checksum.offset + checksum.length ? CHECKSUM_FILL : byte;
    }
    if (sum !== numeric(header, checksum.offset, checksum.length)) {
      throw new ArchiveError(`tar header at byte ${String(offset)} fails its checksum`);
    }
    const size = numeric(header, HEADER.size.offset, HEADER.size.length);
    const type = field(header, HEADER.type.offset, HEADER.type.length);
    const dataStart = offset + BLOCK;
    if (dataStart + size > bytes.length) {
      throw new ArchiveError(`tar member at byte ${String(offset)} runs past the end of the archive`);
    }
    const data = bytes.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    if (type === "L") {
      longName = field(data, 0, data.length);
      continue;
    }
    if (type === "x") {
      longName = paxPath(data);
      continue;
    }
    const name = field(header, HEADER.name.offset, HEADER.name.length);
    const prefix = field(header, HEADER.magic.offset, HEADER.magic.length).startsWith("ustar") ? field(header, HEADER.prefix.offset, HEADER.prefix.length) : "";
    const path = longName ?? (prefix === "" ? name : `${prefix}/${name}`);
    longName = undefined;
    // "0" and an empty (NUL) type mark a regular file, "7" a contiguous one; directories, links and devices carry no data to read.
    if (type === "0" || type === "" || type === "7") {
      members.push({ path, data });
    }
  }

  return members;
}
