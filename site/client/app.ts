/* The client island: the only script the site runs. It wires the home page's search box and filters to the generated search index, offers the copy button beside each entry's fetch command, and registers the service worker. Every page works without it: the listing is static, the command is plain text. */

/** A row of search-index.json, as site/build-site.ts writes it. */
interface SearchRecord {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly domain?: string;
  readonly kind: string;
  readonly tags: readonly string[];
}

function isSearchRecord(value: unknown): value is SearchRecord {
  return typeof value === "object" && value !== null && "id" in value && typeof value.id === "string" && "name" in value && typeof value.name === "string" && "kind" in value && typeof value.kind === "string" && "tags" in value && Array.isArray(value.tags);
}

/** @returns The path back to the site root, which every page's layout sets as data-root. */
function siteRoot(): string {
  const { root } = document.body.dataset;
  if (root === undefined) {
    throw new Error("the page has no data-root");
  }

  return root;
}

const root = siteRoot();

async function wireSearch(form: HTMLFormElement): Promise<void> {
  const response = await fetch(`${root}search-index.json`);
  const parsed: unknown = await response.json();
  if (!Array.isArray(parsed) || !parsed.every(isSearchRecord)) {
    throw new Error("search-index.json is not a list of search records");
  }
  const rows = new Map([...document.querySelectorAll<HTMLTableRowElement>("table.listing tr[data-id]")].map((row) => [row.dataset["id"], row]));
  const text = form.elements.namedItem("text");
  const kind = form.elements.namedItem("kind");
  const domain = form.elements.namedItem("domain");
  const count = form.elements.namedItem("count");
  if (!(text instanceof HTMLInputElement) || !(kind instanceof HTMLSelectElement) || !(domain instanceof HTMLSelectElement) || !(count instanceof HTMLOutputElement)) {
    throw new Error("the search form is missing a field");
  }
  const apply = (): void => {
    const needle = text.value.trim().toLowerCase();
    let shown = 0;
    for (const record of parsed) {
      const haystack = [record.id, record.name, record.description, record.domain, ...record.tags].filter((field) => field !== undefined);
      const visible = (kind.value === "" || record.kind === kind.value) && (domain.value === "" || record.domain === domain.value) && (needle === "" || haystack.some((field) => field.toLowerCase().includes(needle)));
      const row = rows.get(record.id);
      if (row !== undefined) {
        row.hidden = !visible;
      }
      shown += visible ? 1 : 0;
    }
    count.value = `${String(shown)} of ${String(parsed.length)}`;
  };
  form.addEventListener("input", apply);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
  });
  apply();
}

for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-copy]")) {
  button.hidden = false;
  button.addEventListener("click", () => {
    const { copy } = button.dataset;
    if (copy === undefined) {
      throw new Error("a copy button has no text to copy");
    }
    void navigator.clipboard.writeText(copy).then(() => {
      button.textContent = "Copied";
    });
  });
}

const form = document.querySelector<HTMLFormElement>("form.search");
if (form !== null) {
  void wireSearch(form).then(() => {
    form.hidden = false;
  });
}

if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.register(`${root}sw.js`, { scope: root === "" ? "./" : root });
}
