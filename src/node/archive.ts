import { gunzipSync } from "node:zlib";
import { unzipSync, type UnzipFileFilter } from "fflate";
import type { Archive, ArchiveMember } from "../entry";
import { ArchiveError } from "../errors";
import { getOwn } from "../own";
import { readTar } from "./tar";

/** The file a recipe's archive step yields: its bytes, and the member path it came from when the archive holds several. */
export interface Unpacked {
  readonly bytes: Uint8Array;
  readonly member?: string;
}

/**
 * Whether an archive member is a macOS resource fork (`__MACOSX/` or an AppleDouble `._` file), which carries Finder metadata rather than data and never matches a selector.
 * @param path - The member path.
 * @returns True for a resource fork.
 */
function isResourceFork(path: string): boolean {
  return path.startsWith("__MACOSX/") || path.split("/").some((segment) => segment.startsWith("._"));
}

/**
 * Whether a member path matches a selector: a path selector matches the whole member path or its trailing segments, an extensions selector the end of the member's name, ignoring case.
 * @param path - The member path.
 * @param member - The recipe's selector.
 * @returns True on a match.
 */
function selects(path: string, member: ArchiveMember): boolean {
  if (isResourceFork(path) || path.endsWith("/")) {
    return false;
  }
  if ("path" in member) {
    return path === member.path || path.endsWith(`/${member.path}`);
  }

  return member.extensions.some((extension) => path.toLowerCase().endsWith(extension.toLowerCase()));
}

/**
 * Picks the one member a selector matches.
 * @param paths - Every member path.
 * @param member - The recipe's selector.
 * @returns The matching path.
 * @throws ArchiveError when no member or more than one matches, listing the members.
 */
function pick(paths: readonly string[], member: ArchiveMember): string {
  const matched = paths.filter((path) => selects(path, member));
  const [only] = matched;
  if (matched.length !== 1 || only === undefined) {
    const wanted = "path" in member ? `member ${member.path}` : `one member ending ${member.extensions.join(" or ")}`;
    throw new ArchiveError(`expected ${wanted}, found ${String(matched.length)} among: ${paths.join(", ")}`);
  }

  return only;
}

/**
 * Unpacks downloaded bytes into the one file the parser reads.
 * @param bytes - The downloaded bytes.
 * @param archive - The recipe's archive layout.
 * @returns The file's bytes, and its member path for a multi-file archive.
 * @throws ArchiveError when the bytes are not a well-formed archive of the stated kind or the selector does not match exactly one member.
 */
export function unpack(bytes: Uint8Array, archive: Archive): Unpacked {
  if (archive.kind === "none") {
    return { bytes };
  }
  if (archive.kind === "gzip") {
    return { bytes: gunzip(bytes) };
  }
  if (archive.kind === "zip") {
    const names: string[] = [];
    // fflate's filter sees every entry's name before inflating, so listing the names decompresses nothing and only the chosen member is ever inflated.
    unzip(bytes, (file) => {
      names.push(file.name);

      return false;
    });
    const path = pick(names, archive.member);
    const file = getOwn(
      unzip(bytes, (candidate) => candidate.name === path),
      path,
    );
    if (file === undefined) {
      throw new ArchiveError(`zip member ${path} could not be read`);
    }

    return { bytes: file, member: path };
  }
  const members = readTar(archive.kind === "tar" ? bytes : gunzip(bytes));
  const path = pick(
    members.map((member) => member.path),
    archive.member,
  );
  const found = members.find((member) => member.path === path);
  if (found === undefined) {
    throw new ArchiveError(`tar member ${path} could not be read`);
  }

  return { bytes: found.data, member: path };
}

/**
 * Gunzips bytes, rethrowing zlib's failure in the package's taxonomy.
 * @param bytes - Gzip data.
 * @returns The decompressed bytes.
 */
function gunzip(bytes: Uint8Array): Uint8Array {
  try {
    return gunzipSync(bytes);
  } catch (error) {
    throw new ArchiveError(`not valid gzip data: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/**
 * Unzips the entries a filter accepts, rethrowing fflate's failure in the package's taxonomy.
 * @param bytes - Zip data.
 * @param filter - Which entries to inflate.
 * @returns The inflated entries, by name.
 */
function unzip(bytes: Uint8Array, filter: UnzipFileFilter): Readonly<Record<string, Uint8Array>> {
  try {
    return unzipSync(bytes, { filter });
  } catch (error) {
    throw new ArchiveError(`not valid zip data: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
