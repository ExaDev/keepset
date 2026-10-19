import type { Entry } from "./entry";
import { getOwn } from "./own";

/** The character that joins a namespace's segments to each other and to a name. It is not in an id's alphabet, so a name containing it is always a path and never a literal id. */
export const NAME_SEPARATOR = "/";

/** The other names namespace segments go by, as a catalogue manifest declares them: a segment mapped to its aliases. */
export type SegmentAliases = Readonly<Record<string, readonly string[]>>;

/** The names an entry answers to: its fully qualified names, which must each identify it alone, and every name that resolves to it, which also includes the shorter forms. */
export interface EntryNames {
  /** Each address written out in full: the whole path of an address, with no segment alias substituted. */
  readonly full: readonly string[];
  /** Every trailing run of each address's path, the whole path and the bare name among them, with every combination of segment aliases for the namespace part. */
  readonly all: readonly string[];
}

/** The entry fields that give it addresses and groups. */
type Addressed = Pick<Entry, "id" | "namespace" | "aliases">;

/**
 * Splits a path of ids on the separator.
 * @param path - A path such as `a/b`.
 * @returns Its segments.
 */
function segmentsOf(path: string): string[] {
  return path.split(NAME_SEPARATOR);
}

/**
 * The addresses of an entry, each as its path of segments with the name last: the id and every bare alias sit in the entry's own namespace, and an alias that is a path is an address of its own, in the group its leading segments name.
 * @param entry - The entry.
 * @returns One path per id or alias, the id first.
 */
function addressesOf(entry: Addressed): string[][] {
  const { namespace = [], aliases = [] } = entry;

  return [entry.id, ...aliases].map((name) => (name.includes(NAME_SEPARATOR) ? segmentsOf(name) : [...namespace, name]));
}

/**
 * The groups an entry belongs to: the namespace its id and bare aliases sit in, and the group each alias that is a path names, each once, in order of first appearance. A group is a path of segments; an entry belongs to every group above it as well, which the caller reads off the path.
 * @param entry - The entry.
 * @returns The groups, empty for an entry with no namespace and no path aliases.
 */
export function groupsOf(entry: Addressed): string[][] {
  const seen = new Set<string>();

  return addressesOf(entry)
    .map((address) => address.slice(0, -1))
    .filter((group) => {
      const key = group.join(NAME_SEPARATOR);
      if (group.length === 0 || seen.has(key)) {
        return false;
      }
      seen.add(key);

      return true;
    });
}

/**
 * Every spelling of a path of segments when each segment may be replaced by one of its aliases.
 * @param segments - The segments.
 * @param aliases - The segment aliases.
 * @returns Each combination, the unaliased path first.
 */
function spellings(segments: readonly string[], aliases: SegmentAliases): string[][] {
  return segments.reduce<string[][]>((paths, segment) => paths.flatMap((path) => [segment, ...(getOwn(aliases, segment) ?? [])].map((spelling) => [...path, spelling])), [[]]);
}

/**
 * Works out the names an entry answers to. Each address is a path of segments with the name last, and an address answers to every trailing run of its path, so id `c` in namespace `a/b` answers to `c`, `b/c` and `a/b/c`, and the alias `x/y/d` answers to `d`, `y/d` and `x/y/d`. Where the manifest gives a segment aliases, an address also answers with the alias in the segment's place.
 * @param entry - The entry: only its id, namespace and aliases are read.
 * @param segmentAliases - The manifest's aliases for namespace segments, if any.
 * @returns The fully qualified names and every name that resolves to the entry.
 */
export function namesOf(entry: Addressed, segmentAliases: SegmentAliases = {}): EntryNames {
  const addresses = addressesOf(entry);
  const names = addresses.flatMap((address) => {
    const name = address.slice(-1);

    return spellings(address.slice(0, -1), segmentAliases).flatMap((group) => {
      const path = [...group, ...name];

      return Array.from({ length: path.length }, (_unused, depth) => path.slice(path.length - 1 - depth).join(NAME_SEPARATOR));
    });
  });

  return { full: addresses.map((address) => address.join(NAME_SEPARATOR)), all: [...new Set(names)] };
}
