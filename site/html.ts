/** Text made safe to place in HTML: every character that could open a tag, an entity or close an attribute is escaped, so catalogue data never becomes markup. */
export function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/**
 * JSON for a `<script type="application/ld+json">` element. `<` is escaped as `<`, which JSON reads back as the same character, so no string in the data can close the script element.
 * @param value - The JSON value.
 * @returns The script body.
 */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value, undefined, 2).replaceAll("<", "\\u003c");
}

/**
 * A path segment for a listing page: lower case, every run of characters other than letters and digits a single hyphen.
 * @param text - A domain or kind.
 * @returns The slug.
 */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
}
