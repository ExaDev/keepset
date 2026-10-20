/** A node as every parser emits it: an id and nothing else, so one crosswalk serves every parser. */
export interface NativeNode {
  readonly id: string;
}

/** An edge as every parser emits it: source and target node ids, in the file's own direction. */
export interface NativeEdge {
  readonly source: string;
  readonly target: string;
}

/** The native shape every parser in this version emits: the graph's topology, nodes in a deterministic order (each parser documents which) and edges in file order. */
export interface NativeGraph {
  readonly nodes: readonly NativeNode[];
  readonly edges: readonly NativeEdge[];
}

/** A row of a table as the table parser emits it: an id and every column of the file, each a string, a number where the recipe declares the column numeric, or null for an empty cell. Every row carries every column, because a crossmap rule fails on a path absent from any element. */
export interface NativeRow {
  readonly id: string;
  readonly [column: string]: string | number | null;
}

/** The native shape the table parsers emit: a table's rows as nodes, in file order. */
export interface NativeTable {
  readonly nodes: readonly NativeRow[];
}

/** The native shape the instance file parsers emit: the instance's nodes, and a `meta` of its own header values (its name, a vehicle count) that the fetch flow merges beneath the entry's own metadata. */
export interface NativeInstance {
  readonly meta: Readonly<Record<string, string | number | boolean | null>>;
  readonly nodes: readonly NativeRow[];
}

/** What a parser emits: the native shape of its category family, to which the fetch flow adds `meta`. */
export type NativeDocument = NativeGraph | NativeTable | NativeInstance;

/**
 * Collects node ids in order of first appearance, so a parser that learns its nodes from its edges emits them deterministically.
 */
export class NodeOrder {
  readonly #ids = new Set<string>();

  /**
   * Records an id; a repeat keeps its first position.
   * @param id - The node id.
   */
  add(id: string): void {
    this.#ids.add(id);
  }

  /** @returns Whether the id has been recorded. */
  has(id: string): boolean {
    return this.#ids.has(id);
  }

  /** @returns The nodes, in first-appearance order. */
  nodes(): NativeNode[] {
    return [...this.#ids].map((id) => ({ id }));
  }
}

/**
 * Splits text into lines, accepting both LF and CRLF endings.
 * @param text - The file text.
 * @returns The lines, without their terminators.
 */
export function lines(text: string): string[] {
  return text.split(/\r?\n/);
}
