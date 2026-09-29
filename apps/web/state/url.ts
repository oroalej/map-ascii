import { CameraState, Year } from '@atlas/shared';
import * as z from 'zod';
import type { AtlasMode } from './store';

/**
 * The view in the query string (ARCHITECTURE.md §6 "URL sync"). The city is the path, so
 * everything here is relative to it. Parsing never throws: a missing, malformed, or
 * out-of-range parameter is dropped and the view falls back to the city's defaults.
 */
export type ViewParams = {
  camera: Partial<CameraState>;
  year?: number;
  /** Selected feature id. */
  sel?: string;
  tour?: string;
  step?: number;
  mode?: AtlasMode;
};

const cameraFields = {
  lat: CameraState.shape.lat,
  lng: CameraState.shape.lng,
  z: CameraState.shape.zoom,
  pitch: CameraState.shape.pitch,
  bearing: CameraState.shape.bearing,
} as const;

const number = (schema: z.ZodType<number>) => (raw: string | null) => {
  if (raw === null || raw.trim() === '') return undefined;
  const result = schema.safeParse(Number(raw));
  return result.success ? result.data : undefined;
};

const text = (raw: string | null) => {
  const value = raw?.trim();
  return value && value.length <= 200 ? value : undefined;
};

const Mode = z.enum(['map', 'orbit', 'walk']);

/** Read the view from a query string (with or without the leading `?`). */
export function parseViewParams(search: string): ViewParams {
  const q = new URLSearchParams(search);
  const camera: Partial<CameraState> = {};
  const lat = number(cameraFields.lat)(q.get('lat'));
  const lng = number(cameraFields.lng)(q.get('lng'));
  // A position needs both coordinates.
  if (lat !== undefined && lng !== undefined) Object.assign(camera, { lat, lng });
  const zoom = number(cameraFields.z)(q.get('z'));
  if (zoom !== undefined) camera.zoom = zoom;
  const pitch = number(cameraFields.pitch)(q.get('pitch'));
  if (pitch !== undefined) camera.pitch = pitch;
  const bearing = number(cameraFields.bearing)(q.get('bearing'));
  if (bearing !== undefined) camera.bearing = bearing;

  const params: ViewParams = { camera };
  const year = number(Year)(q.get('year'));
  if (year !== undefined) params.year = year;
  const sel = text(q.get('sel'));
  if (sel) params.sel = sel;
  const tour = text(q.get('tour'));
  if (tour) params.tour = tour;
  const step = number(z.int().min(0))(q.get('step'));
  if (step !== undefined && tour) params.step = step;
  const mode = Mode.safeParse(q.get('mode'));
  if (mode.success) params.mode = mode.data;
  return params;
}

const round = (value: number, digits: number) => {
  const f = 10 ** digits;
  const r = Math.round(value * f) / f;
  return Object.is(r, -0) ? 0 : r;
};

export type SerializableView = {
  camera: CameraState;
  year: number;
  /** The year the view shows when the URL has none; left out of the URL when equal. */
  defaultYear: number;
  sel?: string | null;
  tour?: { id: string; step: number } | null;
  mode?: AtlasMode;
};

/**
 * Write the view as a query string (without the `?`). Position and zoom are always there;
 * pitch, bearing, year, and mode only when they differ from their defaults, which keeps
 * everyday links short and still reproduces the exact view.
 */
export function serializeViewParams(view: SerializableView): string {
  const { camera } = view;
  const q = new URLSearchParams();
  q.set('lat', String(round(camera.lat, 6)));
  q.set('lng', String(round(camera.lng, 6)));
  q.set('z', String(round(camera.zoom, 2)));
  const pitch = round(camera.pitch, 1);
  const bearing = round(camera.bearing, 1);
  if (pitch !== 0) q.set('pitch', String(pitch));
  if (bearing !== 0) q.set('bearing', String(bearing));
  if (view.year !== view.defaultYear) q.set('year', String(view.year));
  if (view.sel) q.set('sel', view.sel);
  if (view.tour) {
    q.set('tour', view.tour.id);
    q.set('step', String(view.tour.step));
  }
  if (view.mode && view.mode !== 'map') q.set('mode', view.mode);
  // Feature ids ("osm:way/1") read better with their punctuation left as is.
  return q.toString().replace(/%3A/gi, ':').replace(/%2F/gi, '/');
}
