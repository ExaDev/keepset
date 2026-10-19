/* The client island, now a React application: the whole script the site runs. On a page with a dataset listing it mounts a Mantine-controlled, TanStack-table view over the generated search index (the static table and form stay in the HTML as the no-JS baseline and are hidden once the island is live); on every page it turns each fetch command's mount into a Mantine copy button; everywhere it registers the service worker. Every page still works without it: listings are static, commands are plain text. */

import { useMemo, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Badge, Button, CopyButton, MantineProvider, Select, Table as MantineTable, TextInput, Tooltip } from "@mantine/core";
import "@mantine/core/styles.css";
import { type ColumnDef, createSortedRowModel, rowSortingFeature, tableFeatures, useTable } from "@tanstack/react-table";
import "../styles.css";

/** A row of search-index.json, as site/build-site.ts writes it. */
interface SearchRecord {
  readonly id: string;
  readonly namespace?: string;
  readonly aliases?: readonly string[];
  readonly name: string;
  readonly description?: string;
  readonly domain?: string;
  readonly kind: string;
  readonly tags: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSearchRecord(value: unknown): value is SearchRecord {
  return isRecord(value) && typeof value["id"] === "string" && typeof value["name"] === "string" && typeof value["kind"] === "string" && Array.isArray(value["tags"]);
}

/** @returns The path back to the site root, which every page's layout sets as data-root. */
function siteRoot(): string {
  const { root } = document.body.dataset;
  if (root === undefined) {
    throw new Error("the page has no data-root");
  }

  return root;
}

/** The table's opt-in features, outside the component so the factories are created once: sorting is all the interactive listing needs, because filtering happens on the records before they reach the table. */
const features = tableFeatures({ rowSortingFeature, sortedRowModel: createSortedRowModel() });

type ListingFeatures = typeof features;

/** The interactive listing: filter inputs over the search index and a sortable table of what matches. */
function Listing({ records }: { readonly records: readonly SearchRecord[] }): ReactNode {
  const [text, setText] = useState("");
  const [kind, setKind] = useState<string | null>(null);
  const [domain, setDomain] = useState<string | null>(null);

  const kinds = useMemo(() => [...new Set(records.map((record) => record.kind))].sort(), [records]);
  const domains = useMemo(() => [...new Set(records.flatMap((record) => (record.domain === undefined ? [] : [record.domain])))].sort(), [records]);

  const filtered = useMemo(() => {
    const needle = text.trim().toLowerCase();

    return records.filter((record) => {
      if (kind !== null && record.kind !== kind) {
        return false;
      }
      if (domain !== null && record.domain !== domain) {
        return false;
      }
      if (needle === "") {
        return true;
      }
      const haystack = [record.id, record.namespace, ...(record.aliases ?? []), record.name, record.description, record.domain, ...record.tags].filter((field): field is string => field !== undefined);

      return haystack.some((field) => field.toLowerCase().includes(needle));
    });
  }, [records, text, kind, domain]);

  // Column definitions are written as plain literals against the hook's own column type, not built through createColumnHelper: the helper infers each accessor over its own value type, which does not inter-type with the widened union under exactOptionalPropertyTypes. The order matches the static table's Name, Id, Kind, Domain so the two views of the listing read the same way.
  const columns: readonly ColumnDef<ListingFeatures, SearchRecord>[] = [
    { accessorKey: "name", header: "Name", cell: (info) => <a href={`datasets/${info.row.original.id}/`}>{info.row.original.name}</a> },
    { accessorKey: "id", header: "Id", cell: (info) => <code>{info.row.original.id}</code> },
    { accessorKey: "kind", header: "Kind" },
    { accessorKey: "domain", header: "Domain" },
    { id: "tags", accessorFn: (row) => row.tags.join(", "), header: "Tags" },
  ];

  const table = useTable({ key: "listing", features, data: filtered, columns });

  return (
    <>
      <div className="island-controls">
        <TextInput className="island-search" placeholder="search the catalogue" value={text} onChange={(event) => { setText(event.currentTarget.value); }} />
        <Select className="island-filter" placeholder="kind" data={kinds} value={kind} onChange={(value) => { setKind(value); }} clearable searchable />
        <Select className="island-filter" placeholder="domain" data={domains} value={domain} onChange={(value) => { setDomain(value); }} clearable searchable />
        <Badge variant="light" size="lg">
          {String(filtered.length)} of {String(records.length)}
        </Badge>
      </div>
      {/* The wrapper carries the same classes as the static listing's, so the mobile scroll and the desktop sticky header style both views identically. */}
      <div className="table-wrap listing">
        <MantineTable striped highlightOnHover>
          <MantineTable.Thead>
            {table.getHeaderGroups().map((group) => (
              <MantineTable.Tr key={group.id}>
                {group.headers.map((header) => {
                  const sorted = header.column.getIsSorted();

                  return (
                    <MantineTable.Th
                      key={header.id}
                      onClick={header.column.getToggleSortingHandler()}
                      aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"}
                      style={{ cursor: header.column.getCanSort() ? "pointer" : "default", userSelect: "none" }}
                    >
                      <table.FlexRender header={header} />
                      {sorted === false ? "" : sorted === "asc" ? " ↑" : " ↓"}
                    </MantineTable.Th>
                  );
                })}
              </MantineTable.Tr>
            ))}
          </MantineTable.Thead>
          <MantineTable.Tbody>
            {table.getRowModel().rows.map((row) => (
              <MantineTable.Tr key={row.id}>
                {row.getAllCells().map((cell) => {
                  const value = cell.getValue();

                  // Cells are cut to one line with an ellipsis, so a string value is also the cell's title, which is how the full text is read.
                  return (
                    <MantineTable.Td key={cell.id} title={typeof value === "string" ? value : undefined}>
                      <table.FlexRender cell={cell} />
                    </MantineTable.Td>
                  );
                })}
              </MantineTable.Tr>
            ))}
          </MantineTable.Tbody>
        </MantineTable>
      </div>
    </>
  );
}

/** One fetch command's copy affordance, rendered where the generator left a mount naming the command. */
function CopyCommand({ command }: { readonly command: string }): ReactNode {
  return (
    <CopyButton value={command} timeout={2000}>
      {({ copied, copy }) => (
        <Tooltip label={copied ? "Copied" : "Copy"} withArrow>
          <Button color={copied ? "teal" : "accent"} size="compact-xs" variant="light" onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </Button>
        </Tooltip>
      )}
    </CopyButton>
  );
}

async function mountListing(root: string, mount: HTMLElement): Promise<void> {
  const response = await fetch(`${root}search-index.json`);
  const parsed: unknown = await response.json();
  if (!Array.isArray(parsed) || !parsed.every(isSearchRecord)) {
    throw new Error("search-index.json is not a list of search records");
  }
  createRoot(mount).render(
    <MantineProvider defaultColorScheme="auto">
      <Listing records={parsed} />
    </MantineProvider>,
  );
}

const root = siteRoot();

const listing = document.querySelector<HTMLElement>("#island-root");
if (listing !== null) {
  void mountListing(root, listing).then(() => {
    // Only now does the interactive view take over: the live class shows the mount, and the stylesheet hides the static listing that follows it.
    listing.classList.add("island-live");
  });
}

for (const mount of document.querySelectorAll<HTMLElement>("[data-copy-command]")) {
  const { copyCommand } = mount.dataset;
  if (copyCommand === undefined) {
    throw new Error("a copy mount has no command to copy");
  }
  createRoot(mount).render(
    <MantineProvider defaultColorScheme="auto">
      <CopyCommand command={copyCommand} />
    </MantineProvider>,
  );
}

if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.register(`${root}sw.js`, { scope: root === "" ? "./" : root });
}
