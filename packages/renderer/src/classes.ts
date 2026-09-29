import { ATLAS_CLASSES, bandVisibility, CLASS_ZOOM, type AtlasClass } from '@atlas/shared';

/** Point markers the renderer adds on top of features (SPEC.md §4). */
export const markerClasses = [
  'marker_religious',
  'marker_school',
  'marker_market',
  'marker_landmark',
] as const;
export type MarkerClass = (typeof markerClasses)[number];

/**
 * The life layer's simulated agents (life/simulate.ts). They are drawn over the map from their
 * own texture, never into cells, so they can't be picked and never reach the class buffer.
 */
export const lifeClasses = ['life_vehicle', 'life_person', 'life_boat', 'life_bird'] as const;
export type LifeClass = (typeof lifeClasses)[number];

/**
 * Everything the renderer draws with a class color: the pipeline's classes, markers, and the
 * life layer's agents.
 */
export type RenderClass = AtlasClass | MarkerClass | LifeClass;

/**
 * Id 0 means "empty cell"; classes are numbered from 1 in this order. Markers come first so
 * they, like the road and detail classes early in `AtlasClass`, keep ids that fit the select
 * shader's 32-bit class masks (glyphs/select.ts `classBit`). Life classes come last; they are
 * never in a mask.
 */
export const renderClasses: readonly RenderClass[] = [
  ...markerClasses,
  ...ATLAS_CLASSES,
  ...lifeClasses,
];

/**
 * Size of the per-class uniform arrays and the glyph table's class axis. The table's last three
 * rows hold wall and extrusion glyphs (glyphs/select.ts).
 */
export const MAX_CLASSES = 48;
if (renderClasses.length >= MAX_CLASSES - 3) throw new Error('too many render classes');

const ids = new Map<string, number>(renderClasses.map((c, i) => [c, i + 1]));

/** The cell-buffer id of a class, or 0 if the name is unknown. */
export const classId = (name: string): number => ids.get(name) ?? 0;

/**
 * The classes present in a read of the class buffer (RGBA bytes, class id in red), in id order.
 * Empty cells (id 0) and unknown ids are skipped.
 */
export function classesIn(texels: Uint8Array): RenderClass[] {
  const seen = new Uint8Array(256);
  for (let i = 0; i < texels.length; i += 4) seen[texels[i]!] = 1;
  const out: RenderClass[] = [];
  for (let id = 1; id <= renderClasses.length; id++) if (seen[id]) out.push(renderClasses[id - 1]!);
  return out;
}

/** The marker drawn at a feature's center for its class, if any. */
export const markerFor: Partial<Record<AtlasClass, MarkerClass>> = {
  building_religious: 'marker_religious',
  building_school: 'marker_school',
  building_market: 'marker_market',
};

/**
 * Draw priority tiers, highest first (ARCHITECTURE.md §4: landmark > road > building > water >
 * area > terrain). Within a tier, taller wins: buildings sit on top of the height-less school,
 * church, and market grounds that share their classes, and higher terrain bands (the height
 * byte holds the band) on top of the lower bands they nest in. Admin boundaries run over
 * buildings and under paths. Classes not listed (place labels, drawn as text) are never cells.
 */
export const priority: readonly (readonly RenderClass[])[] = [
  ['marker_landmark'],
  ['marker_religious', 'marker_school', 'marker_market', 'monument'],
  ['tree', 'furniture', 'entrance'],
  ['road_major'],
  ['road_mid'],
  ['road_minor'],
  ['path', 'barrier'],
  ['admin_city', 'admin_subdivision'],
  ['building', 'building_religious', 'building_school', 'building_market', 'building_part'],
  ['water_river', 'water_stream'],
  ['coastline'],
  ['water_area', 'water_sea'],
  ['park', 'trees', 'farmland', 'parking', 'pitch'],
  ['terrain'],
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

/**
 * How much of each class shows at `zoom`, 0–1, from the shared `CLASS_ZOOM` table (SPEC.md §2
 * levels): classes fade in and out over half a zoom level instead of popping. The cell pass
 * turns a fraction into a dither (that share of cells, chosen by a fixed per-cell hash), so a
 * layer dissolves into what lies under it. Markers follow their features, so they are always 1.
 */
export function classVisibility(zoom: number): Float32Array {
  const visibility = new Float32Array(MAX_CLASSES).fill(1);
  for (const cls of ATLAS_CLASSES) {
    visibility[classId(cls)] = bandVisibility(CLASS_ZOOM[cls], zoom);
  }
  return visibility;
}

/** Per-feature flag bits, stored in the cell pass's attribute buffer. */
export const Flags = {
  landmark: 1,
  /** A road drawn as a strip of its real width (Place level), not as a 1-cell line. */
  corridor: 2,
  /** Part of a building's 3D extrusion (drawn only when the camera is tilted). */
  extruded: 4,
  /** An extrusion's roof (else a wall). */
  roof: 8,
  /** An extrusion vertex at the building's height (else at the ground). */
  top: 16,
  /** A pitched roof: the vertex carries its signed distance to the ridge, and the ridge angle. */
  ridged: 32,
} as const;

/**
 * The per-vertex variant byte from the pipeline's `variant` property: which furniture glyph to
 * draw, or a building's roof (1 = flat, 2 = pitched, 0 = unknown).
 */
export function variantCode(className: string, variant: unknown): number {
  if (typeof variant !== 'string') return 0;
  if (className === 'furniture') return ['bench', 'fountain', 'flagpole'].indexOf(variant) + 1;
  if (className.startsWith('building')) return variant === 'flat' ? 1 : 2;
  return 0;
}
