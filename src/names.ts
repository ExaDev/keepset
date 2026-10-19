import type { Entry } from "./entry";

/** The character that joins a namespace's segments to each other and to a name. It is not in an id's alphabet, so a name containing it is always a path and never a literal id. */
export const NAME_SEPARATOR = "/";

/** The names an entry answers to: its fully qualified names, which must each identify it alone, and every name that resolves to it, which also includes the shorter forms. */
export interface EntryNames {
  /** The whole namespace joined to each leaf, or the bare leaf for an entry with no namespace. */
  readonly full: readonly string[];
  /** Every suffix of the namespace joined to each leaf, the fully qualified name and the bare leaf among them. */
  readonly all: readonly string[];
}

/**
 * Works out the names an entry answers to. A leaf is the entry's id or one of its aliases; a name is a leaf with any trailing run of the entry's namespace segments before it, so an entry in namespace `a/b` with id `c` answers to `c`, `b/c` and `a/b/c`.
 * @param entry - The entry: only its id, namespace and aliases are read.
 * @returns The fully qualified names and every name that resolves to the entry.
 */
export function namesOf(entry: Pick<Entry, "id" | "namespace" | "aliases">): EntryNames {
  const { namespace = [], aliases = [] } = entry;
  const leaves = [entry.id, ...aliases];

  return {
    full: leaves.map((leaf) => [...namespace, leaf].join(NAME_SEPARATOR)),
    all: leaves.flatMap((leaf) => Array.from({ length: namespace.length + 1 }, (_unused, depth) => [...namespace.slice(namespace.length - depth), leaf].join(NAME_SEPARATOR))),
  };
}
