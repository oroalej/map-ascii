/** Canonical landmark metadata carried by linked grounds, safe for worker imports. */
import { ATLAS_CLASSES } from './constants';
import type { AtlasClass } from './schemas';

export type DetailSelection = {
  id: string;
  class: AtlasClass;
  name?: string;
  landmarkId?: string;
  subdivision?: string;
  subdivisionApprox?: boolean;
  kind?: string;
  height?: number;
};

const strings = ['name', 'landmarkId', 'subdivision', 'kind'] as const;
const allowed = new Set(['id', 'class', ...strings, 'subdivisionApprox', 'height']);

export function isDetailSelection(value: unknown): value is DetailSelection {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    Object.keys(v).every((key) => allowed.has(key)) &&
    typeof v.id === 'string' &&
    /^osm:(node|way|relation)\/\d+$/.test(v.id) &&
    typeof v.class === 'string' &&
    ATLAS_CLASSES.some((cls) => cls === v.class) &&
    strings.every(
      (key) => v[key] === undefined || (typeof v[key] === 'string' && v[key].length <= 512),
    ) &&
    (v.landmarkId === undefined || /^landmark\/[a-z0-9-]+$/.test(v.landmarkId as string)) &&
    (v.subdivisionApprox === undefined || typeof v.subdivisionApprox === 'boolean') &&
    (v.height === undefined ||
      (typeof v.height === 'number' &&
        Number.isFinite(v.height) &&
        v.height > 0 &&
        v.height <= 255))
  );
}

/** Older archives omit this field; malformed optional metadata is ignored. */
export function parseDetailSelection(value: unknown): DetailSelection | undefined {
  if (typeof value !== 'string' || value.length > 4096) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isDetailSelection(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
