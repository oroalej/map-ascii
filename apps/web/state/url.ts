import { CAMERA_RANGES, YEAR_RANGE, type CameraState } from '@atlas/shared';

/**
 * The view in the query string (ARCHITECTURE.md §6 "URL sync"). The city is the path, so
 * everything here is relative to it. Parsing never throws: a missing, malformed, or
 * out-of-range parameter is dropped and the view falls back to the city's defaults. Links from
 * before the map went flat may carry `pitch`, `bearing`, or `mode`; they are ignored.
 */
export type ViewParams = {
  camera: Partial<CameraState>;
  year?: number;
  /** Selected feature id. */
  sel?: string;
  tour?: string;
  step?: number;
};

/** A number in `[min, max]` (an integer with `integer`), or undefined. */
const number =
  ([min, max]: readonly [number, number], integer = false) =>
  (raw: string | null) => {
    if (raw === null || raw.trim() === '') return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min || value > max) return undefined;
    return integer && !Number.isInteger(value) ? undefined : value;
  };

const text = (raw: string | null) => {
  const value = raw?.trim();
  return value && value.length <= 200 ? value : undefined;
};

/** Read the view from a query string (with or without the leading `?`). */
export function parseViewParams(search: string): ViewParams {
  const q = new URLSearchParams(search);
  const camera: Partial<CameraState> = {};
  const lat = number(CAMERA_RANGES.lat)(q.get('lat'));
  const lng = number(CAMERA_RANGES.lng)(q.get('lng'));
  // A position needs both coordinates.
  if (lat !== undefined && lng !== undefined) Object.assign(camera, { lat, lng });
  const zoom = number(CAMERA_RANGES.zoom)(q.get('z'));
  if (zoom !== undefined) camera.zoom = zoom;

  const params: ViewParams = { camera };
  const year = number(YEAR_RANGE, true)(q.get('year'));
  if (year !== undefined) params.year = year;
  const sel = text(q.get('sel'));
  if (sel) params.sel = sel;
  const tour = text(q.get('tour'));
  if (tour) params.tour = tour;
  const step = number([0, Number.MAX_SAFE_INTEGER], true)(q.get('step'));
  if (step !== undefined && tour) params.step = step;
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
};

/**
 * Write the view as a query string (without the `?`). Position and zoom are always there;
 * the year only when it differs from the default, which keeps everyday links short and still
 * reproduces the exact view.
 */
export function serializeViewParams(view: SerializableView): string {
  const { camera } = view;
  const q = new URLSearchParams();
  q.set('lat', String(round(camera.lat, 6)));
  q.set('lng', String(round(camera.lng, 6)));
  q.set('z', String(round(camera.zoom, 2)));
  if (view.year !== view.defaultYear) q.set('year', String(view.year));
  if (view.sel) q.set('sel', view.sel);
  if (view.tour) {
    q.set('tour', view.tour.id);
    q.set('step', String(view.tour.step));
  }
  // Feature ids ("osm:way/1") read better with their punctuation left as is.
  return q.toString().replace(/%3A/gi, ':').replace(/%2F/gi, '/');
}
