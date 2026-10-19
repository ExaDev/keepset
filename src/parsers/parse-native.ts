import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import { parseEdgeList } from "./edge-list";
import { parseGml } from "./gml";
import { parseMatrixMarket } from "./matrix-market";
import { parseCsvTable } from "./csv-table";
import { parseGeojson } from "./geojson";
import type { NativeDocument, NativeGraph, NativeTable } from "./native";
import { parsePajek } from "./pajek";

/** Bytes converted per String.fromCharCode call: spreading a whole file would exceed the engine's argument-count limit, and this many stays well inside every engine's. */
const LATIN1_CHUNK = 0x8000;

/**
 * Decodes a file's bytes in the recipe's encoding, strictly: bytes that are not valid utf-8 fail rather than becoming replacement characters. latin1 maps every byte to the code point of the same value, so it cannot fail.
 * @param bytes - The unpacked file.
 * @param parser - The recipe's parser, which names the encoding.
 * @returns The file text.
 */
export function decode(bytes: Uint8Array, parser: Parser): string {
  if (parser.encoding === "latin1") {
    // ISO-8859-1 proper, not TextDecoder's "latin1" label, which the WHATWG Encoding Standard maps to windows-1252 and so reads bytes 0x80 to 0x9F differently.
    let text = "";
    for (let start = 0; start < bytes.length; start += LATIN1_CHUNK) {
      text += String.fromCharCode(...bytes.subarray(start, start + LATIN1_CHUNK));
    }

    return text;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    // TextDecoder reports invalid bytes only as a TypeError with no position; rethrown in the package's own taxonomy so the recipe names the step.
    throw new NativeParseError(parser.format, 1, `the file is not valid utf-8 (${error instanceof Error ? error.message : String(error)}); a recipe for a latin1 file states encoding latin1`);
  }
}

const KIBIBYTE = 1024;
const PIECE_MEBIBYTES = 8;

/** Bytes decoded at a time for a format that is read in pieces. The decoder holds only a piece's text at once, so this bounds what a large table costs beyond its bytes; it is large enough that the per-piece work is small beside the piece. */
export const DECODE_PIECE_BYTES = PIECE_MEBIBYTES * KIBIBYTE * KIBIBYTE;

/**
 * Decodes a file's bytes in the recipe's encoding a piece at a time, as strictly as `decode`, so a file whose text would not fit in one string can still be read.
 * @param bytes - The unpacked file.
 * @param parser - The recipe's parser, which names the encoding.
 * @param pieceBytes - How many bytes to decode at a time.
 * @returns The text of each piece, in order; a character that spans two pieces is yielded whole with the later one.
 * @throws NativeParseError when the bytes are not valid in the stated encoding.
 */
export function* decodePieces(bytes: Uint8Array, parser: Parser, pieceBytes: number = DECODE_PIECE_BYTES): Generator<string, void, undefined> {
  const decoder = parser.encoding === "latin1" ? undefined : new TextDecoder("utf-8", { fatal: true });
  try {
    for (let start = 0; start < bytes.length; start += pieceBytes) {
      const piece = bytes.subarray(start, start + pieceBytes);
      yield decoder === undefined ? decode(piece, parser) : decoder.decode(piece, { stream: true });
    }
    if (decoder !== undefined) {
      const rest = decoder.decode();
      if (rest !== "") {
        yield rest;
      }
    }
  } catch (error) {
    if (error instanceof NativeParseError) {
      throw error;
    }
    throw new NativeParseError(parser.format, 1, `the file is not valid utf-8 (${error instanceof Error ? error.message : String(error)}); a recipe for a latin1 file states encoding latin1`);
  }
}

type TableParser = Extract<Parser, { format: "csv-table" | "geojson" }>;

/**
 * Reads a file into the native shape of the recipe's parser: a graph for the graph formats, a table of rows for the table formats.
 * @param bytes - The unpacked file.
 * @param parser - The recipe's parser.
 * @returns The native document.
 * @throws NativeParseError when the bytes are not valid in the stated encoding or the text is not in the stated format.
 */
export function parseNative(bytes: Uint8Array, parser: TableParser): NativeTable;
export function parseNative(bytes: Uint8Array, parser: Exclude<Parser, TableParser>): NativeGraph;
export function parseNative(bytes: Uint8Array, parser: Parser): NativeDocument;
export function parseNative(bytes: Uint8Array, parser: Parser): NativeDocument {
  if (parser.format === "csv-table") {
    return parseCsvTable(decodePieces(bytes, parser), parser);
  }
  const text = decode(bytes, parser);
  if (parser.format === "geojson") {
    return parseGeojson(text, parser);
  }
  if (parser.format === "edge-list") {
    return parseEdgeList(text, parser);
  }
  if (parser.format === "matrix-market") {
    return parseMatrixMarket(text);
  }
  if (parser.format === "gml") {
    return parseGml(text);
  }

  return parsePajek(text);
}
