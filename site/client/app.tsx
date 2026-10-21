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
  readonly subjects?: readonly string[];
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
      const haystack = [record.id, record.namespace, ...(record.aliases ?? []), record.name, record.description, record.domain, ...(record.subjects ?? []), ...record.tags].filter((field): field is string => field !== undefined);

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

/** How many rows the preview table shows before it stops, whatever the result holds: a tab shows a sample, the JSON download carries the whole result. */
const PREVIEW_ROWS = 100;

/** How many characters of a SHA-256 the preview shows beside the result, enough to identify it against the report. */
const HASH_SHOWN = 12;

/** Narrows an unknown value to a record of its own entries, so the preview reads fields it checks for rather than asserting a shape. */
function narrowRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  return Object.fromEntries(Object.entries(value));
}

/** Narrows unknown rows to record rows, refusing anything that is not an array of objects. */
function narrowRows(value: unknown): readonly Record<string, unknown>[] | undefined {
  if (!Array.isArray(value) || !value.every((row) => typeof row === "object" && row !== null && !Array.isArray(row))) {
    return undefined;
  }

  return value.map((row) => narrowRecord(row) ?? {});
}

/** Narrows unknown instances to id-carrying pairs, refusing anything else. */
function narrowInstances(value: unknown): readonly { readonly id: string; readonly value: unknown }[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const narrowed: { readonly id: string; readonly value: unknown }[] = [];
  for (const one of value) {
    const record = narrowRecord(one);
    if (record !== undefined && typeof record["id"] === "string") {
      narrowed.push({ id: record["id"], value: record });
    }
  }

  return narrowed;
}

/** What the preview's done answer carries, narrowed from the worker's unknown by checking its shape. */
function previewOf(data: unknown): { readonly meta: unknown; readonly nodes?: readonly Record<string, unknown>[]; readonly instances?: readonly { readonly id: string; readonly value: unknown }[] } | undefined {
  const record = narrowRecord(data);
  if (record === undefined || !("meta" in record)) {
    return undefined;
  }
  const nodes = narrowRows(record["nodes"]);
  const instances = narrowInstances(record["instances"]);

  return { meta: record["meta"], ...(nodes === undefined ? {} : { nodes }), ...(instances === undefined ? {} : { instances }) };
}

/** The preview of one dataset: a button that runs the recipe in the worker, the result's nodes in a table, a JSON download, an instance picker for a collection, and a file drop for a source the page could not read. */
function Preview({ id }: { readonly id: string }): ReactNode {
  const [state, setState] = useState<"idle" | "working" | "done" | "unreadable" | "error">("idle");
  const [data, setData] = useState<ReturnType<typeof previewOf>>(undefined);
  const [provenance, setProvenance] = useState<{ readonly sha256: string; readonly byteLength: number } | null>(null);
  const [instance, setInstance] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [worker, setWorker] = useState<Worker | null>(null);

  /** Sends the request to the worker, creating it on first use, and routes each answer to the state it leaves the preview in. */
  const ask = (bytes?: ArrayBuffer): void => {
    setState("working");

    const run = worker ?? new Worker(`${siteRoot()}fetchWorker.js`, { type: "module" });
    setWorker(run);
    run.onmessage = (event: MessageEvent<{ readonly kind: string; readonly data?: unknown; readonly provenance?: { readonly sha256: string; readonly byteLength: number }; readonly message?: string }>): void => {
      const answer = event.data;
      if (answer.kind === "done" && answer.data !== undefined && answer.provenance !== undefined) {
        setData(previewOf(answer.data));
        setProvenance(answer.provenance);
        setState("done");

        return;
      }
      if (answer.kind === "unreadable") {
        setState("unreadable");

        return;
      }
      if (answer.kind === "error" && answer.message !== undefined) {
        setMessage(answer.message);
        setState("error");
      }
    };
    run.onerror = (): void => {
      setMessage("the preview worker failed to start");
      setState("error");
    };
    run.postMessage({ id, ...(bytes === undefined ? {} : { bytes }) });
  };

  /** Reads the dropped file as bytes and asks again with them standing in for the source. */
  const dropped = (file: Readonly<File>): void => {
    void file.arrayBuffer().then((bytes) => {
      ask(bytes);
    });
  };

  const chosen = instance !== null && data?.instances !== undefined ? data.instances.find((one) => one.id === instance)?.value : undefined;
  const rows = data?.nodes ?? previewOf(chosen)?.nodes ?? [];
  const instances = data?.instances;

  return (
    <div className="preview-controls">
      {state === "working" ? <span>Fetching and running the recipe...</span> : <Button onClick={() => { ask(); }}>Fetch and preview</Button>}
      {state === "unreadable" ? (
        <div className="preview-drop">
          <p>The page could not read this source (the host refuses cross-origin requests). Download it with the command above, then drop the file here to preview it.</p>
          <input type="file" onChange={(event) => { const file = event.target.files?.[0]; if (file !== undefined) { dropped(file); } }} />
        </div>
      ) : null}
      {state === "error" ? <p className="preview-error">{message}</p> : null}
      {state === "done" ? (
        <div className="preview-result">
          {instances !== undefined ? <Select data={instances.map((one) => ({ value: one.id, label: one.id }))} value={instance} onChange={setInstance} placeholder="Choose an instance" /> : null}
          {rows.length > 0 ? (
            <MantineTable>
              <thead><tr>{Object.keys(rows[0] ?? {}).map((column) => <th key={column}>{column}</th>)}</tr></thead>
              <tbody>{rows.slice(0, PREVIEW_ROWS).map((row, index) => <tr key={String(index)}>{Object.values(row).map((value, at) => <td key={String(at)}>{typeof value === "object" && value !== null ? JSON.stringify(value) : String(value)}</td>)}</tr>)}</tbody>
            </MantineTable>
          ) : (
            <p>The result holds no node rows.</p>
          )}
          {rows.length > PREVIEW_ROWS ? <p>Showing {String(PREVIEW_ROWS)} of {String(rows.length)} rows; the download carries the whole result.</p> : null}
          {provenance !== null ? <p className="preview-provenance">SHA-256 {provenance.sha256.slice(0, HASH_SHOWN)}, {String(provenance.byteLength)} bytes.</p> : null}
          <Button component="a" href={URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }))} download={`${id}.json`}>Download JSON</Button>
        </div>
      ) : null}
    </div>
  );
}

for (const mount of document.querySelectorAll<HTMLElement>("[data-preview-id]")) {
  const { previewId } = mount.dataset;
  if (previewId !== undefined) {
    createRoot(mount).render(
      <MantineProvider>
        <Preview id={previewId} />
      </MantineProvider>,
    );
  }
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
