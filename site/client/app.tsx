/* The client island, now a React application: the whole script the site runs. On a page with a dataset listing it mounts a Mantine-controlled, TanStack-table view over the generated search index (the static table and form stay in the HTML as the no-JS baseline and are hidden once the island is live); on every page it turns each fetch command's mount into a Mantine copy button; everywhere it registers the service worker. Every page still works without it: listings are static, commands are plain text. */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Badge, Button, CopyButton, MantineProvider, NumberInput, Select, Table as MantineTable, TextInput, Tooltip } from "@mantine/core";
import "@mantine/core/styles.css";
import "leaflet/dist/leaflet.css";
import { CircleMarker, MapContainer, TileLayer } from "react-leaflet";
import { type ColumnDef, createSortedRowModel, rowSortingFeature, tableFeatures, useTable } from "@tanstack/react-table";
import { formatBytes, formatCount, type Dimensions } from "../dimensions";
import "../styles.css";

/** A row of search-index.json, as site/build-site.ts writes it. */
interface SearchRecord extends Dimensions {
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

/** The count bounds the listing filters by: a minimum and a maximum for nodes and for edges, with the placeholder each input shows. */
type BoundKey = "minNodes" | "maxNodes" | "minEdges" | "maxEdges";
const BOUND_INPUTS: readonly (readonly [BoundKey, string])[] = [
  ["minNodes", "min nodes"],
  ["maxNodes", "max nodes"],
  ["minEdges", "min edges"],
  ["maxEdges", "max edges"],
];

/**
 * Whether a recorded count lies inside the bounds set on it. A count the entry does not record is inside no bound, so setting one hides the entries that cannot answer it.
 * @param count - The count, or undefined where the entry records none.
 * @param min - The least wanted, when set.
 * @param max - The most wanted, when set.
 * @returns True when the count passes every bound that is set.
 */
function within(count: number | undefined, min: number | undefined, max: number | undefined): boolean {
  if (min === undefined && max === undefined) {
    return true;
  }

  return count !== undefined && (min === undefined || count >= min) && (max === undefined || count <= max);
}

/** The interactive listing: filter inputs over the search index and a sortable table of what matches. */
function Listing({ records }: { readonly records: readonly SearchRecord[] }): ReactNode {
  const [text, setText] = useState("");
  const [kind, setKind] = useState<string | null>(null);
  const [domain, setDomain] = useState<string | null>(null);
  const [bounds, setBounds] = useState<Readonly<Record<BoundKey, number | undefined>>>({ minNodes: undefined, maxNodes: undefined, minEdges: undefined, maxEdges: undefined });

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
      if (!within(record.nodes, bounds.minNodes, bounds.maxNodes) || !within(record.edges, bounds.minEdges, bounds.maxEdges)) {
        return false;
      }
      if (needle === "") {
        return true;
      }
      const haystack = [record.id, record.namespace, ...(record.aliases ?? []), record.name, record.description, record.domain, ...(record.subjects ?? []), ...record.tags].filter((field): field is string => field !== undefined);

      return haystack.some((field) => field.toLowerCase().includes(needle));
    });
  }, [records, text, kind, domain, bounds]);

  // Column definitions are written as plain literals against the hook's own column type, not built through createColumnHelper: the helper infers each accessor over its own value type, which does not inter-type with the widened union under exactOptionalPropertyTypes. The order matches the static table's Name, Id, Kind, Domain so the two views of the listing read the same way.
  const columns: readonly ColumnDef<ListingFeatures, SearchRecord>[] = [
    { accessorKey: "name", header: "Name", cell: (info) => <a href={`datasets/${info.row.original.id}/`}>{info.row.original.name}</a> },
    { accessorKey: "id", header: "Id", cell: (info) => <code>{info.row.original.id}</code> },
    { accessorKey: "kind", header: "Kind" },
    { accessorKey: "domain", header: "Domain" },
    // An unrecorded count sorts after every recorded one, whichever way the column is sorted.
    { id: "nodes", accessorFn: (row) => row.nodes, header: "Nodes", sortUndefined: "last", cell: (info) => formatCount(info.row.original.nodes) },
    { id: "edges", accessorFn: (row) => row.edges, header: "Edges", sortUndefined: "last", cell: (info) => formatCount(info.row.original.edges) },
    { id: "instances", accessorFn: (row) => row.instances, header: "Instances", sortUndefined: "last", cell: (info) => formatCount(info.row.original.instances) },
    { id: "size", accessorFn: (row) => row.bytes, header: "Size", sortUndefined: "last", cell: (info) => formatBytes(info.row.original.bytes) },
    { id: "tags", accessorFn: (row) => row.tags.join(", "), header: "Tags" },
  ];

  const table = useTable({ key: "listing", features, data: filtered, columns });

  return (
    <>
      <div className="island-controls">
        <TextInput className="island-search" placeholder="search the catalogue" value={text} onChange={(event) => { setText(event.currentTarget.value); }} />
        <Select className="island-filter" placeholder="kind" data={kinds} value={kind} onChange={(value) => { setKind(value); }} clearable searchable />
        <Select className="island-filter" placeholder="domain" data={domains} value={domain} onChange={(value) => { setDomain(value); }} clearable searchable />
        {BOUND_INPUTS.map(([key, placeholder]) => (
          <NumberInput key={key} className="island-bound" placeholder={placeholder} min={0} allowNegative={false} allowDecimal={false} value={bounds[key] ?? ""} onChange={(value) => { setBounds((current) => ({ ...current, [key]: typeof value === "number" ? value : undefined })); }} />
        ))}
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

/** How many points the map draws before it samples evenly instead, so a tab stays responsive whatever the result holds; the sample is even over the row order, so a spatial pattern survives it. */
const MAP_POINTS = 10_000;

/** The size of the planar plot's canvas, and the margin its points keep from the edge. */
const CANVAS_WIDTH = 600;
const CANVAS_HEIGHT = 400;
const CANVAS_MARGIN = 10;

/** The side of one plotted point on the canvas, in pixels. */
const POINT_SIDE = 2;

/** The map's starting zoom, wide enough to show a continent before it fits itself to the points. */
const MAP_ZOOM = 4;

/** The radius of a circle marker on the map, in pixels. */
const MARKER_RADIUS = 2;

/** A point placed by geography. */
interface GeoPoint {
  readonly lat: number;
  readonly lon: number;
}

/** A point placed on a plane. */
interface PlanarPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * The rows that carry a latitude and a longitude, as points.
 * @param rows - The preview's rows.
 * @returns The geographic points, or undefined when no row is placed by geography.
 */
function geoPointsOf(rows: readonly Record<string, unknown>[]): readonly GeoPoint[] | undefined {
  const placed: GeoPoint[] = [];
  for (const row of rows) {
    const { lat, lon } = row;
    if (typeof lat === "number" && typeof lon === "number") {
      placed.push({ lat, lon });
    }
  }

  return placed.length === 0 ? undefined : placed;
}

/**
 * The rows that carry planar x and y and no geography, as points.
 * @param rows - The preview's rows.
 * @returns The planar points, or undefined when no row is placed only by x and y.
 */
function planarPointsOf(rows: readonly Record<string, unknown>[]): readonly PlanarPoint[] | undefined {
  const placed: PlanarPoint[] = [];
  for (const row of rows) {
    const { x, y, lat } = row;
    if (typeof x === "number" && typeof y === "number" && lat === undefined) {
      placed.push({ x, y });
    }
  }

  return placed.length === 0 ? undefined : placed;
}

/**
 * Every n-th point so that at most `MAP_POINTS` remain, evenly over the order.
 * @param points - The points.
 * @returns The points, or an even sample of them.
 */
function sampled<T>(points: readonly T[]): readonly T[] {
  const step = Math.ceil(points.length / MAP_POINTS);

  return step <= 1 ? points : points.filter((_, index) => index % step === 0);
}

/** Draws planar points on a canvas, with no tiles: a planar dataset's plane has no geography to show under it. */
function PlanarCanvas({ points }: { readonly points: readonly PlanarPoint[] }): ReactNode {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const context = canvas?.getContext("2d");
    if (canvas === null || context === null || context === undefined) {
      return;
    }
    context.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const spanX = Math.max(...xs) - minX || 1;
    const spanY = Math.max(...ys) - minY || 1;
    context.fillStyle = "#1f4e79";
    for (const point of points) {
      const px = ((point.x - minX) / spanX) * (CANVAS_WIDTH - 2 * CANVAS_MARGIN) + CANVAS_MARGIN;
      const py = CANVAS_HEIGHT - CANVAS_MARGIN - ((point.y - minY) / spanY) * (CANVAS_HEIGHT - 2 * CANVAS_MARGIN);
      context.fillRect(px, py, POINT_SIDE, POINT_SIDE);
    }
  }, [points]);

  return <canvas ref={ref} width={CANVAS_WIDTH} height={CANVAS_HEIGHT} className="preview-canvas" aria-label="A scatter of the result's points on the plane" />;
}

/** The map of a result's geographic points: OpenStreetMap tiles under Leaflet, both free with the attribution shown, and a circle marker per sampled point. */
function PointMap({ points }: { readonly points: readonly GeoPoint[] }): ReactNode {
  const drawn = sampled(points);
  const lats = drawn.map((point) => point.lat);
  const lons = drawn.map((point) => point.lon);
  const centre: [number, number] = [(Math.min(...lats) + Math.max(...lats)) / 2, (Math.min(...lons) + Math.max(...lons)) / 2];

  return (
    <div className="preview-map">
      <MapContainer center={centre} zoom={MAP_ZOOM} scrollWheelZoom style={{ height: `${String(CANVAS_HEIGHT)}px`, width: "100%" }}>
        <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" />
        {drawn.map((point, index) => (
          <CircleMarker key={String(index)} center={[point.lat, point.lon]} radius={MARKER_RADIUS} pathOptions={{ color: "#1f4e79", fillOpacity: 0.7 }} />
        ))}
      </MapContainer>
      {points.length > MAP_POINTS ? <p>Drawing {String(drawn.length)} of {String(points.length)} points, sampled evenly over the result's order.</p> : null}
    </div>
  );
}

/** The preview of one dataset: a button that runs the recipe in the worker, the result's nodes in a table, a JSON download, an instance picker for a collection, and a file drop for a source the page could not read. */
function Preview({ id }: { readonly id: string }): ReactNode {
  const [state, setState] = useState<"idle" | "working" | "done" | "unreadable" | "error">("idle");
  const [data, setData] = useState<ReturnType<typeof previewOf>>(undefined);
  const [provenance, setProvenance] = useState<{ readonly sha256: string; readonly byteLength: number } | null>(null);
  const [instance, setInstance] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [captured, setCaptured] = useState(false);
  const [worker, setWorker] = useState<Worker | null>(null);

  /** Sends the request to the worker, creating it on first use, and routes each answer to the state it leaves the preview in. */
  const ask = (bytes?: ArrayBuffer): void => {
    setState("working");
    setCaptured(false);

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
      if (answer.kind === "captured") {
        setCaptured(true);

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
  const geo = geoPointsOf(rows);
  const planar = planarPointsOf(rows);
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
          {geo === undefined ? null : <PointMap points={geo} />}
          {planar === undefined ? null : <PlanarCanvas points={sampled(planar)} />}
          {captured ? <p className="preview-capture">No snapshot of this source was readable, so it was read live and the Internet Archive was asked to capture it, which leaves the next visitor a snapshot to read.</p> : null}
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
