/* The dataset preview, in a module of its own so the listing and every page without a preview never load it: the entry point imports it only when a page holds a preview mount. The map inside it is a further lazy chunk, loaded when a result has coordinates. */

import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Button, MantineProvider, Select, Table as MantineTable } from "@mantine/core";
import type { GeoPoint } from "./point-map";
import { siteRoot } from "./site-root";

const PointMap = lazy(async () => import("./point-map"));

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
          {geo === undefined ? null : (
            <Suspense fallback={<p>Loading the map...</p>}>
              <PointMap points={sampled(geo)} total={geo.length} height={CANVAS_HEIGHT} />
            </Suspense>
          )}
          {planar === undefined ? null : <PlanarCanvas points={sampled(planar)} />}
          {captured ? <p className="preview-capture">No snapshot of this source was readable, so it was read live and the Internet Archive was asked to capture it, which leaves the next visitor a snapshot to read.</p> : null}
          {provenance !== null ? <p className="preview-provenance">SHA-256 {provenance.sha256.slice(0, HASH_SHOWN)}, {String(provenance.byteLength)} bytes.</p> : null}
          <Button component="a" href={URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }))} download={`${id}.json`}>Download JSON</Button>
        </div>
      ) : null}
    </div>
  );
}

/** Mounts a preview on every element that names a dataset to preview. */
export function mountPreviews(): void {
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
}
