/** Helpers shared by the readers of spreadsheet formats that store their parts as XML (xlsx and OpenDocument): they read the flat, namespace-prefixed markup those parts are written in, without building a tree. */

const HEXADECIMAL = 16;
const DECIMAL = 10;

/** One element's attributes, by name with any namespace prefix kept (`r:id`). */
export type Attributes = Readonly<Record<string, string>>;

/**
 * Replaces the XML entities and character references of a text.
 * @param text - Escaped text.
 * @returns The text.
 */
export function unescape(text: string): string {
  return text.replaceAll(/&(#x[0-9A-Fa-f]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_whole, entity: string) => {
    if (entity.startsWith("#x")) {
      return String.fromCodePoint(Number.parseInt(entity.slice(2), HEXADECIMAL));
    }
    if (entity.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(entity.slice(1), DECIMAL));
    }

    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[entity] ?? "";
  });
}

/**
 * The attributes of a start tag's text.
 * @param tag - The text between `<` and `>`, name included.
 * @returns The attributes, unescaped.
 */
export function attributesOf(tag: string): Attributes {
  const attributes: Record<string, string> = {};
  for (const [, name, value] of tag.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) {
    if (name !== undefined && value !== undefined) {
      attributes[name] = unescape(value);
    }
  }

  return attributes;
}

/**
 * The start tags of one element name in an XML part, in order.
 * @param xml - The part's text.
 * @param name - The element name.
 * @returns The attributes of each start tag.
 */
export function elements(xml: string, name: string): Attributes[] {
  return [...xml.matchAll(new RegExp(`<${name}(?=[\\s/>])([^>]*)>`, "g"))].map((match) => attributesOf(match[1] ?? ""));
}
