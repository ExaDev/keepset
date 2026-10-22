/* The map of a result's geographic points, in a module of its own so Leaflet and react-leaflet load only when a result with coordinates is previewed (the preview imports it lazily). Leaflet's stylesheet is imported by the page's entry, because the stylesheet of a lazily loaded chunk is never linked. */

import type { ReactNode } from "react";
import { CircleMarker, MapContainer, TileLayer } from "react-leaflet";

/** The map's starting zoom, wide enough to show a continent before it fits itself to the points. */
const MAP_ZOOM = 4;

/** The radius of a circle marker on the map, in pixels. */
const MARKER_RADIUS = 2;

/** A point placed by geography. */
export interface GeoPoint {
  readonly lat: number;
  readonly lon: number;
}

/**
 * The map: OpenStreetMap tiles under Leaflet, both free with the attribution shown, and a circle marker per point.
 * @param props - The map's props.
 * @param props.points - The points to draw.
 * @param props.total - How many points the result held before they were sampled.
 * @param props.height - The map's height in pixels.
 * @returns The map.
 */
export default function PointMap({ points, total, height }: { readonly points: readonly GeoPoint[]; readonly total: number; readonly height: number }): ReactNode {
  const lats = points.map((point) => point.lat);
  const lons = points.map((point) => point.lon);
  const centre: [number, number] = [(Math.min(...lats) + Math.max(...lats)) / 2, (Math.min(...lons) + Math.max(...lons)) / 2];

  return (
    <div className="preview-map">
      <MapContainer center={centre} zoom={MAP_ZOOM} scrollWheelZoom style={{ height: `${String(height)}px`, width: "100%" }}>
        <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" />
        {points.map((point, index) => (
          <CircleMarker key={String(index)} center={[point.lat, point.lon]} radius={MARKER_RADIUS} pathOptions={{ color: "#1f4e79", fillOpacity: 0.7 }} />
        ))}
      </MapContainer>
      {total > points.length ? <p>Drawing {String(points.length)} of {String(total)} points, sampled evenly over the result's order.</p> : null}
    </div>
  );
}
