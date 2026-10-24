import { z } from "zod";

/* What the SuiteSparse Matrix Collection's own index says about a matrix beyond what the pipeline catalogue records: the kind of problem it comes from, which is the entry's domain. The index page is the only place the collection states a matrix's kind, so it is read once by probe-suitesparse-index.ts and committed, and the import reads the committed copy and never the network. */

/** The path a matrix has under the collection's `MM` directory: `MM/<group>/<name>.tar.gz`. */
const MATRIX_PATH = /^MM\/([^/]+)\/([^/]+)\.tar\.gz$/;

/** The index: the day it was read and the kind of each matrix named `<group>/<name>`. */
export const SuiteSparseIndexSchema = z
  .object({
    readOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: "must be a date, YYYY-MM-DD" }),
    kinds: z.record(z.string().regex(/^[^/]+\/[^/]+$/), z.string().min(1)),
  })
  .strict();
export type SuiteSparseIndex = z.infer<typeof SuiteSparseIndexSchema>;

/**
 * The index's name for a matrix.
 * @param path - A `MM/<group>/<name>.tar.gz` path.
 * @returns `<group>/<name>`, or undefined when the path is not a Matrix Market download.
 */
export function matrixKey(path: string): string | undefined {
  const match = MATRIX_PATH.exec(path);

  return match?.[1] === undefined || match[2] === undefined ? undefined : `${match[1]}/${match[2]}`;
}

/** The text of the entities an HTML table cell holds, which the index page writes for the few characters it escapes. */
const ENTITIES: ReadonlyMap<string, string> = new Map([
  ["&amp;", "&"],
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&quot;", '"'],
  ["&#39;", "'"],
]);

/**
 * The text of an index page cell.
 * @param html - The cell's inner HTML.
 * @returns The text with tags removed, the escaped characters restored and the whitespace collapsed.
 */
function cellText(html: string): string {
  const text = html.replace(/<[^>]*>/g, "");

  return text.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ENTITIES.get(entity) ?? entity).replace(/\s+/g, " ").trim();
}

/**
 * Reads each matrix's kind from the collection's index page, whose table has one row per matrix with its group, name and kind in cells named by class.
 * @param html - The page.
 * @returns The kind of each matrix named `<group>/<name>`, the first row winning where a matrix is listed twice.
 */
export function parseIndexKinds(html: string): ReadonlyMap<string, string> {
  const kinds = new Map<string, string>();
  for (const [row] of html.matchAll(/<tr>.*?<\/tr>/gs)) {
    const cell = (column: string): string | undefined => {
      const found = new RegExp(`<td class='column-${column}[^']*'>(.*?)</td>`, "s").exec(row);

      return found?.[1] === undefined ? undefined : cellText(found[1]);
    };
    const [name, group, kind] = [cell("name"), cell("group"), cell("kind")];
    if (name !== undefined && group !== undefined && kind !== undefined && kind !== "" && !kinds.has(`${group}/${name}`)) {
      kinds.set(`${group}/${name}`, kind);
    }
  }

  return kinds;
}
