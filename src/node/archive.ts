import { gunzipSync } from "node:zlib";
import { unzipSync, type UnzipFileFilter } from "fflate";
import type { CollectionArchive, DocumentArchive, ArchiveMember, InnerArchive } from "../entry";
import { ArchiveError } from "../errors";
import { getOwn } from "../own";
import { readTar } from "./tar";
import { sheetToCsv } from "./xlsx";

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
 * Whether a member path matches a selector: a path selector matches the whole member path or its trailing segments, an extensions selector the end of the member's name (ignoring case), a pattern selector the whole path.
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
  if ("pattern" in member) {
    return new RegExp(`^(?:${member.pattern})$`, "u").test(path);
  }

  return member.extensions.some((extension) => path.toLowerCase().endsWith(extension.toLowerCase()));
}

/**
 * Describes what a selector asks for, for an error message.
 * @param member - The selector.
 * @param noun - How to name the member or members.
 * @returns The member path, extensions or pattern it names.
 */
function describeSelector(member: ArchiveMember, noun: string): string {
  if ("path" in member) {
    return `${noun === "one member" ? "member" : noun} ${member.path}`;
  }

  return "pattern" in member ? `${noun} matching ${member.pattern}` : `${noun} ending ${member.extensions.join(" or ")}`;
}

/**
 * Picks every member a selector matches, in path order, so a collection reads in the same order wherever it is unpacked.
 * @param paths - Every member path.
 * @param member - The recipe's selector.
 * @returns The matching paths, sorted, at least one.
 * @throws ArchiveError when no member matches, listing the members.
 */
function pickAll(paths: readonly string[], member: ArchiveMember): string[] {
  const matched = paths.filter((path) => selects(path, member)).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  if (matched.length === 0) {
    throw new ArchiveError(`expected at least one ${describeSelector(member, "member")}, found none among: ${paths.join(", ")}`);
  }

  return matched;
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
    throw new ArchiveError(`expected ${describeSelector(member, "one member")}, found ${String(matched.length)} among: ${paths.join(", ")}`);
  }

  return only;
}

/**
 * Unpacks downloaded bytes into the one file the parser reads. A member with an `inner` archive is unpacked again by that layout, and the path reported is the outer member's, joined by `/` to the inner member's when the inner layout selects one, as though the inner archive were a directory.
 * @param bytes - The downloaded bytes.
 * @param archive - The recipe's archive layout.
 * @returns The file's bytes, and its member path for a multi-file archive.
 * @throws ArchiveError when the bytes, or a member's bytes that an `inner` layout reads, are not a well-formed archive of the stated kind or a selector does not match exactly one member.
 */
export function unpack(bytes: Uint8Array, archive: DocumentArchive): Unpacked {
  if (archive.kind === "none") {
    return { bytes };
  }
  if (archive.kind === "gzip") {
    return { bytes: gunzip(bytes) };
  }
  if (archive.kind === "xlsx") {
    return { bytes: sheetToCsv(bytes, archive.sheet), member: archive.sheet };
  }
  const outer = selectMember(bytes, archive);
  if (archive.inner === undefined) {
    return outer;
  }
  if (archive.inner.kind === "gzip") {
    return { bytes: gunzip(outer.bytes), member: outer.member };
  }
  const inner = selectMember(outer.bytes, archive.inner);

  return { bytes: inner.bytes, member: `${outer.member}/${inner.member}` };
}

/**
 * Unpacks the one member a file archive's selector matches.
 * @param bytes - The archive's bytes.
 * @param archive - A file archive layout and its selector.
 * @returns The member's bytes and path.
 * @throws ArchiveError when the bytes are not a well-formed archive of the stated kind or the selector does not match exactly one member.
 */
function selectMember(bytes: Uint8Array, archive: Exclude<InnerArchive, { readonly kind: "gzip" }>): { readonly bytes: Uint8Array; readonly member: string } {
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

/** One file of a collection: its path in the archive and its bytes. */
export interface Member {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/**
 * Unpacks downloaded bytes into every file a collection's selector matches.
 * @param bytes - The downloaded bytes.
 * @param archive - The recipe's archive layout, which selects members with `members`.
 * @returns Each matching file, in path order.
 * @throws ArchiveError when the bytes are not a well-formed archive of the stated kind or the selector matches no member.
 */
export function unpackMembers(bytes: Uint8Array, archive: CollectionArchive): Member[] {
  if (archive.kind === "zip") {
    const names: string[] = [];
    unzip(bytes, (file) => {
      names.push(file.name);

      return false;
    });
    const paths = pickAll(names, archive.members);
    const chosen = new Set(paths);
    const files = unzip(bytes, (candidate) => chosen.has(candidate.name));

    return paths.map((path) => {
      const file = getOwn(files, path);
      if (file === undefined) {
        throw new ArchiveError(`zip member ${path} could not be read`);
      }

      return { path, bytes: file };
    });
  }
  const members = readTar(archive.kind === "tar" ? bytes : gunzip(bytes));

  return pickAll(
    members.map((member) => member.path),
    archive.members,
  ).map((path) => {
    const found = members.find((member) => member.path === path);
    if (found === undefined) {
      throw new ArchiveError(`tar member ${path} could not be read`);
    }

    return { path, bytes: found.data };
  });
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
