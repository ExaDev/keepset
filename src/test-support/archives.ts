import { gzipSync } from "node:zlib";
import { zipSync } from "fflate";
import { BLOCK, CHECKSUM_FILL, HEADER } from "../node/tar";

const OCTAL = 8;
const FILE_MODE = 0o644;

/** A header field's position in the ustar header. */
interface Field {
  readonly offset: number;
  readonly length: number;
}

function writeField(header: Uint8Array, at: Field, text: string): void {
  header.set(new TextEncoder().encode(text).subarray(0, at.length), at.offset);
}

/** Octal text filling a numeric field: zero-padded digits, then a NUL. */
function octal(value: number, at: Field): string {
  return `${value.toString(OCTAL).padStart(at.length - 1, "0")}\0`;
}

/** One file to put in a test archive. Type `5` writes a directory, `L` a GNU long-name record. */
export interface ArchiveFile {
  readonly path: string;
  readonly text: string;
  readonly type?: string;
}

/**
 * Writes a ustar archive, with a correct checksum on every header and a GNU long-name record before any path longer than the name field holds.
 * @param files - The members.
 * @returns The archive bytes.
 */
export function tar(files: readonly ArchiveFile[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  const member = (path: string, data: Uint8Array, type: string): void => {
    const header = new Uint8Array(BLOCK);
    writeField(header, HEADER.name, path);
    writeField(header, HEADER.mode, octal(FILE_MODE, HEADER.mode));
    writeField(header, HEADER.size, octal(data.length, HEADER.size));
    writeField(header, HEADER.type, type);
    writeField(header, HEADER.magic, "ustar\0");
    writeField(header, HEADER.version, "00");
    header.fill(CHECKSUM_FILL, HEADER.checksum.offset, HEADER.checksum.offset + HEADER.checksum.length);
    const sum = header.reduce((total, byte) => total + byte, 0);
    // The checksum field is six octal digits, a NUL and a space.
    writeField(header, HEADER.checksum, `${sum.toString(OCTAL).padStart(HEADER.checksum.length - 2, "0")}\0 `);
    blocks.push(header);
    const padded = new Uint8Array(Math.ceil(data.length / BLOCK) * BLOCK);
    padded.set(data);
    blocks.push(padded);
  };
  for (const file of files) {
    const data = new TextEncoder().encode(file.text);
    if (file.path.length > HEADER.name.length) {
      member("././@LongLink", new TextEncoder().encode(`${file.path}\0`), "L");
    }
    member(file.path.slice(0, HEADER.name.length), data, file.type ?? "0");
  }
  blocks.push(new Uint8Array(BLOCK * 2));
  const out = new Uint8Array(blocks.reduce((total, block) => total + block.length, 0));
  let offset = 0;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.length;
  }

  return out;
}

/**
 * Writes a zip archive.
 * @param files - The members.
 * @returns The archive bytes.
 */
export function zip(files: readonly ArchiveFile[]): Uint8Array {
  return zipSync(Object.fromEntries(files.map((file) => [file.path, new TextEncoder().encode(file.text)])));
}

/**
 * Gzips text or bytes.
 * @param data - The data.
 * @returns The gzip bytes.
 */
export function gzip(data: string | Uint8Array): Uint8Array {
  return gzipSync(typeof data === "string" ? new TextEncoder().encode(data) : data);
}
