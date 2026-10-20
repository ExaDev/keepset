/** A node as every parser emits it: an id and nothing else, so one crosswalk serves every parser. */
export interface NativeNode {
  readonly id: string;
}

/** An edge as every parser emits it: source and target node ids, in the file's own direction. */
export interface NativeEdge {
  readonly source: string;
  readonly target: string;
}

/** A node of a bipartite graph whose two sets are told apart by a type, as the ratings parser emits it. */
export interface NativeTypedNode extends NativeNode {
  readonly type: string;
}

/** An edge that is one rating: the user it runs from, the item it runs to, its weight (the rating over the scale's maximum) and when it was given, in the source's own unit. */
export interface NativeRating extends NativeEdge {
  readonly type: string;
  readonly weight: number;
  readonly timestamp: number;
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

const CARRIAGE_RETURN = 0x0d;

/**
 * Visits the lines of a file read in pieces, accepting both LF and CRLF endings, holding only the unfinished end of a piece between pieces so a file larger than one string can be read.
 * @param pieces - The file's text, in order, split anywhere (even between a carriage return and its line feed).
 * @param visit - Called with each line, without its terminator, and its 1-based number. A final line without a terminator is visited; the empty text after a final terminator is not a line.
 */
export function forEachLine(pieces: Readonly<Iterable<string>>, visit: (line: string, number: number) => void): void {
  let carry = "";
  let number = 0;
  const emit = (text: string, start: number, end: number): void => {
    number += 1;
    visit(end > start && text.charCodeAt(end - 1) === CARRIAGE_RETURN ? text.slice(start, end - 1) : text.slice(start, end), number);
  };
  for (const piece of pieces) {
    const text = carry + piece;
    let start = 0;
    for (let end = text.indexOf("\n", start); end !== -1; end = text.indexOf("\n", start)) {
      emit(text, start, end);
      start = end + 1;
    }
    carry = text.slice(start);
  }
  if (carry !== "") {
    emit(carry, 0, carry.length);
  }
}
