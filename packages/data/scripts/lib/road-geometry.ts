import type { Position } from 'geojson';
import type { AtlasFeature, AtlasProperties } from '../03-normalize';
import { defaultRoadWidths } from './classify';

/** Matches the renderer's SIGNAL.gap before the signal's stopping envelope, in metres. */
export const SIGNAL_STOP_GAP_M = 1.5;

export const key = (p: Position) => `${p[0]},${p[1]}`;
export const delta = (a: Position, b: Position) =>
  [(b[0]! - a[0]!) * 111320 * Math.cos((a[1]! * Math.PI) / 180), (b[1]! - a[1]!) * 111320] as const;
export const lines = (f: AtlasFeature): Position[][] =>
  f.geometry.type === 'LineString'
    ? [f.geometry.coordinates]
    : f.geometry.type === 'MultiLineString'
      ? f.geometry.coordinates
      : [];
export const width = (road: AtlasFeature) =>
  road.properties.width ?? defaultRoadWidths[road.properties.class] ?? 6;
/** Event paths need a measured width; ordinary seasonal roads retain their fallback. */
export const eventWidth = (road: AtlasFeature) =>
  road.properties.class === 'path' ? Number(road.properties.event_path_width ?? 0) : width(road);

export const point = (
  id: string,
  position: Position,
  properties: Partial<AtlasProperties>,
): AtlasFeature => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [...position] },
  properties: { id, class: 'furniture', ...properties },
  tippecanoe: { layer: 'poi', minzoom: 15, maxzoom: 16 },
});
