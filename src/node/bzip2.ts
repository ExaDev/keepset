import unbzip2 from "unbzip2-stream";
import { ArchiveError } from "../errors";

/** The four bytes every bzip2 stream starts with, as ASCII: `BZh` and the block size digit, `1` to `9`. */
const MAGIC = /^BZh[1-9]$/;
const MAGIC_LENGTH = 4;

/**
 * Whether the bytes start a bzip2 stream.
 * @param bytes - The data.
 * @returns True when they begin with `BZh` and a block size digit.
 */
function startsStream(bytes: Uint8Array): boolean {
  return MAGIC.test(String.fromCharCode(...bytes.subarray(0, MAGIC_LENGTH)));
}

/**
 * Decompresses bzip2 data: one stream or several concatenated ones, as `bzip2 -d` reads them. The decoder verifies every block's CRC and the stream's, and fails on input that ends inside a stream or holds anything after the last one, so a download cut short or corrupted never yields a prefix of the file.
 *
 * `unbzip2-stream` is a stream interface, but its decoder runs inside `write` and `end` and emits every `data`, `error` and `end` event before they return, so one write of the whole input and an `end` give the whole output synchronously; the check that `end` was emitted guards that.
 * @param bytes - The compressed data.
 * @returns The decompressed bytes.
 * @throws ArchiveError when the data does not start with a bzip2 header, fails a CRC, ends early or holds trailing bytes that are not another stream.
 */
export function bunzip2(bytes: Uint8Array): Uint8Array {
  if (!startsStream(bytes)) {
    throw new ArchiveError("not valid bzip2 data: it does not start with the BZh header and a block size digit");
  }
  const decoder = unbzip2();
  const chunks: Uint8Array[] = [];
  const outcome: { failure?: unknown; finished: boolean } = { finished: false };
  decoder.on("data", (chunk: Uint8Array) => {
    chunks.push(chunk);
  });
  decoder.on("error", (error: unknown) => {
    outcome.failure ??= error;
  });
  decoder.on("end", () => {
    outcome.finished = true;
  });
  decoder.write(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  decoder.end();
  if (outcome.failure !== undefined) {
    throw new ArchiveError(`not valid bzip2 data: ${outcome.failure instanceof Error ? outcome.failure.message : JSON.stringify(outcome.failure)}`, { cause: outcome.failure });
  }
  if (!outcome.finished) {
    throw new ArchiveError("the bzip2 decoder did not finish when its input ended");
  }

  const joined = Buffer.concat(chunks);

  // A plain Uint8Array over the same memory: callers get the type every other unpacker returns, not a Buffer.
  return new Uint8Array(joined.buffer, joined.byteOffset, joined.byteLength);
}
