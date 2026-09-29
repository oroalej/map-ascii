import { AtlasClass } from '@atlas/shared';

/** Point markers the renderer adds on top of features (SPEC.md §4). */
export const markerClasses = [
  'marker_religious',
  'marker_school',
  'marker_market',
  'marker_landmark',
] as const;
export type MarkerClass = (typeof markerClasses)[number];

/** Everything the cell pass can write into a cell: the pipeline's classes plus markers. */
export type RenderClass = AtlasClass | MarkerClass;

/** Id 0 means "empty cell"; classes are numbered from 1 in this order. */
export const renderClasses: readonly RenderClass[] = [...AtlasClass.options, ...markerClasses];

/** Size of the per-class uniform arrays and the glyph table's class axis. */
export const MAX_CLASSES = 32;
if (renderClasses.length >= MAX_CLASSES) throw new Error('too many render classes');

const ids = new Map<string, number>(renderClasses.map((c, i) => [c, i + 1]));

/** The cell-buffer id of a class, or 0 if the name is unknown. */
export const classId = (name: string): number => ids.get(name) ?? 0;

/** The marker drawn at a feature's center for its class, if any. */
export const markerFor: Partial<Record<AtlasClass, MarkerClass>> = {
  building_religious: 'marker_religious',
  building_school: 'marker_school',
  building_market: 'marker_market',
};

/**
 * Draw priority tiers, highest first (ARCHITECTURE.md §4: landmark > road > building > water >
 * area). Within the building tier, taller wins, so buildings sit on top of the height-less
 * school, church, and market grounds that share their classes. Classes not listed are never
 * drawn in Phase 1 (admin outlines and labels arrive in Phase 2).
 */
export const priority: readonly (readonly RenderClass[])[] = [
  ['marker_landmark'],
  ['marker_religious', 'marker_school', 'marker_market'],
  ['road_major'],
  ['road_mid'],
  ['road_minor'],
  ['path'],
  ['building', 'building_religious', 'building_school', 'building_market'],
  ['water_river'],
  ['water_area'],
  ['park', 'trees', 'farmland'],
];

/** Clip-space depth between tiers. */
export const TIER_STEP = 2 / (priority.length + 1);

/**
 * Depth per class id for the cell pass, in clip space (-1 nearest). Earlier tiers get smaller
 * depths and win the depth test; the cell shader subtracts up to 0.9 × TIER_STEP by height.
 * Undrawn classes get 2, which clips them.
 */
export function classDepths(): Float32Array {
  const depths = new Float32Array(MAX_CLASSES).fill(2);
  priority.forEach((tier, rank) => {
    for (const cls of tier) depths[classId(cls)] = -1 + (rank + 1) * TIER_STEP;
  });
  return depths;
}

/** Per-feature flag bits, stored in the cell pass's attribute buffer. */
export const Flags = { landmark: 1 } as const;
