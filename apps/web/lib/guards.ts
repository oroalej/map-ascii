/**
 * Shape checks for the generated files the browser loads. The pipeline validates each with its
 * zod schema when it writes it (steps 05 and 06), so these only catch a missing, stale, or
 * hand-edited file, and keep zod out of the browser bundle (ARCHITECTURE.md §8 initial JS).
 */
import {
  CAMERA_RANGES,
  type CameraState,
  type CityMeta,
  type SearchIndexFile,
  type SubdivisionArea,
} from '@atlas/shared';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isNumbers = (v: unknown, length: number) =>
  Array.isArray(v) && v.length === length && v.every(isNumber);
const isLocalized = (v: unknown) => isRecord(v) && isText(v.en) && Object.values(v).every(isText);

function isCamera(v: unknown): v is CameraState {
  if (!isRecord(v)) return false;
  return (Object.keys(CAMERA_RANGES) as (keyof CameraState)[]).every((field) => {
    const value = v[field];
    const [min, max] = CAMERA_RANGES[field];
    return isNumber(value) && value >= min && value <= max;
  });
}

export function isCityMeta(v: unknown): v is CityMeta {
  return (
    isRecord(v) &&
    isText(v.slug) &&
    isLocalized(v.name) &&
    isLocalized(v.subdivisionLabel) &&
    Array.isArray(v.languages) &&
    v.languages.every(isText) &&
    isNumbers(v.bounds, 4) &&
    isNumbers(v.regionBounds, 4) &&
    isCamera(v.defaultCamera) &&
    isNumbers(v.yearRange, 2) &&
    Array.isArray(v.attribution) &&
    v.attribution.every(isText)
  );
}

export function isSubdivisionAreas(v: unknown): v is SubdivisionArea[] {
  return (
    Array.isArray(v) &&
    v.every(
      (area) =>
        isRecord(area) &&
        isText(area.name) &&
        typeof area.approximate === 'boolean' &&
        isRecord(area.geometry) &&
        isText(area.geometry.type) &&
        Array.isArray(area.geometry.coordinates),
    )
  );
}

export function isSearchIndexFile(v: unknown): v is SearchIndexFile {
  return (
    isRecord(v) &&
    v.version === 1 &&
    isRecord(v.index) &&
    Array.isArray(v.entries) &&
    v.entries.every(
      (e) =>
        isRecord(e) &&
        isText(e.id) &&
        isText(e.name) &&
        isText(e.type) &&
        Array.isArray(e.altNames) &&
        isNumber(e.lat) &&
        isNumber(e.lng) &&
        isNumber(e.zoomHint),
    )
  );
}
