/* A table of every row of a result, however many it holds: only the rows near the viewport are in the page, inside a scrolling frame, so a result of a million edges browses as smoothly as one of ten. */

import { useMemo, useRef, type ReactNode } from "react";
import { Table as MantineTable } from "@mantine/core";
import { useVirtualizer } from "@tanstack/react-virtual";

/** A first-paint estimate of a row's height in pixels; every rendered row is measured, so it only sizes the scrollbar until the first rows exist. */
const ESTIMATED_ROW_HEIGHT = 34;

/** How many rows beyond the frame are rendered on each side, so a fast scroll does not show blank space. */
const ROW_OVERSCAN = 10;

/** The height of the scrolling frame in pixels. */
const FRAME_HEIGHT = 420;

/**
 * The columns of a set of rows: every key any row has, in the order each first appears, since the rows of a result need not all carry the same optional fields.
 * @param rows - The rows.
 * @returns The column names.
 */
function columnsOf(rows: readonly Record<string, unknown>[]): readonly string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      seen.add(key);
    }
  }

  return [...seen];
}

/**
 * Writes one cell: a nested value as JSON, an absent one as nothing.
 * @param value - The cell's value.
 * @returns The text.
 */
function cellText(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }

  // What is left is a nested value, and the result arrived by structured clone from JSON, so JSON can write it.
  return JSON.stringify(value);
}

/** Every row of a result in a virtualised, scrolling table. */
export function DataTable({ rows }: { readonly rows: readonly Record<string, unknown>[] }): ReactNode {
  const columns = useMemo(() => columnsOf(rows), [rows]);
  const frame = useRef<HTMLDivElement>(null);
  const virtualiser = useVirtualizer({ count: rows.length, getScrollElement: () => frame.current, estimateSize: () => ESTIMATED_ROW_HEIGHT, overscan: ROW_OVERSCAN });
  const items = virtualiser.getVirtualItems();
  const spaceAbove = items[0]?.start ?? 0;
  const spaceBelow = items.length === 0 ? 0 : virtualiser.getTotalSize() - (items.at(-1)?.end ?? 0);

  return (
    <div ref={frame} className="preview-table" style={{ maxHeight: FRAME_HEIGHT, overflow: "auto" }}>
      <MantineTable stickyHeader striped highlightOnHover>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {spaceAbove > 0 ? <tr aria-hidden="true" style={{ height: spaceAbove }} /> : null}
          {items.map((item) => {
            const row = rows[item.index];

            return (
              <tr key={item.index} data-index={item.index} ref={virtualiser.measureElement}>
                {columns.map((column) => (
                  <td key={column}>{cellText(row?.[column])}</td>
                ))}
              </tr>
            );
          })}
          {spaceBelow > 0 ? <tr aria-hidden="true" style={{ height: spaceBelow }} /> : null}
        </tbody>
      </MantineTable>
    </div>
  );
}
