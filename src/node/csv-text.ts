/**
 * One CSV field as the table parser reads it: quoted, with its quotes doubled, when it holds a comma, a quote or a line break, and as it is otherwise.
 * @param text - The cell text.
 * @returns The field.
 */
export function csvField(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
