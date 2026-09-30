import { ATLAS_CLASSES, bandVisibility, CLASS_ZOOM, type AtlasClass } from '@atlas/shared';

/** Point markers the renderer adds on top of features (SPEC.md §4). */
export const markerClasses = [
  'marker_religious',
  'marker_school',
  'marker_market',
  'marker_station',
  'marker_landmark',
] as const;
export type MarkerClass = (typeof markerClasses)[number];

/**
 * Parts of a feature the renderer draws in their own class: a tree's crown (raster/geometry.ts),
 * around the `tree` point that marks its trunk. Each shows when its feature's class does.
 */
export const partClasses = ['tree_crown'] as const;
export type PartClass = (typeof partClasses)[number];
export const partOf: Readonly<Record<PartClass, AtlasClass>> = { tree_crown: 'tree' };

/**
 * The life layer's simulated agents (life/simulate.ts). They are drawn over the map from their
 * own texture, never into cells, so they can't be picked and never reach the class buffer.
 */
export const lifeClasses = [
  'life_vehicle',
  'life_person',
  'life_boat',
  'life_bird',
  'life_train',
] as const;
export type LifeClass = (typeof lifeClasses)[number];

/**
 * Everything the renderer draws with a class color: the pipeline's classes, markers, feature
 * parts, and the life layer's agents.
 */
export type RenderClass = AtlasClass | MarkerClass | PartClass | LifeClass;

/**
 * Id 0 means "empty cell"; classes are numbered from 1 in this order. Markers come first so
 * they, like the road and detail classes early in `AtlasClass`, keep ids that fit the select
 * shader's 32-bit class masks (glyphs/select.ts `classBit`). Parts and life classes come last;
 * they are never in a mask.
 */
export const renderClasses: readonly RenderClass[] = [
  ...markerClasses,
  ...ATLAS_CLASSES,
  ...partClasses,
  ...lifeClasses,
];

/**
 * Size of the per-class uniform arrays and the glyph table's class axis. The table's last five
 * rows hold sextant, roof-ridge, and wall glyphs (glyphs/select.ts).
 */
export const MAX_CLASSES = 48;
if (renderClasses.length >= MAX_CLASSES - 5) throw new Error('too many render classes');

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
  building_station: 'marker_station',
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
  ['marker_religious', 'marker_school', 'marker_market', 'marker_station', 'monument'],
  ['tree', 'furniture', 'entrance'],
  ['road_major'],
  ['road_mid'],
  ['road_minor'],
  // Under the roads, so a level crossing keeps the road's glyph.
  ['path', 'barrier', 'rail'],
  ['admin_city', 'admin_subdivision'],
  [
    'building',
    'building_religious',
    'building_school',
    'building_market',
    'building_station',
    'building_part',
  ],
  ['water_river', 'water_stream'],
  ['coastline'],
  ['water_area', 'water_sea'],
  // Crowns over the parks and grounds they stand in, under roads and buildings.
  ['tree_crown'],
  ['park', 'trees', 'farmland', 'parking', 'pitch'],
  // Under the parks, woods, and fields drawn on it.
  ['grass'],
  ['terrain'],
];

/**
 * Classes whose features without a height are grounds (a campus, a church's grounds) rather
 * than buildings. Grounds are drawn under everything on them but terrain (`groundDepth`), so a
 * lawn, garden, or pond inside a campus shows.
 */
export const groundClasses: readonly RenderClass[] = [
  'building',
  'building_religious',
  'building_school',
  'building_market',
  'building_station',
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

/** The cell pass's depth for grounds: under grass, above terrain. */
export function groundDepth(): number {
  const depths = classDepths();
  return (depths[classId('grass')]! + depths[classId('terrain')]!) / 2;
}

/**
 * How much of each class shows at `zoom`, 0–1, from the shared `CLASS_ZOOM` table (SPEC.md §2
 * levels): classes fade in and out over half a zoom level instead of popping. The cell pass
 * turns a fraction into a dither (that share of cells, chosen by a fixed per-cell hash), so a
 * layer dissolves into what lies under it. Markers follow their features, so they are always 1;
 * parts follow their feature's class.
 */
export function classVisibility(zoom: number): Float32Array {
  const visibility = new Float32Array(MAX_CLASSES).fill(1);
  for (const cls of ATLAS_CLASSES) {
    visibility[classId(cls)] = bandVisibility(CLASS_ZOOM[cls], zoom);
  }
  for (const part of partClasses) visibility[classId(part)] = visibility[classId(partOf[part])]!;
  return visibility;
}

/** Per-feature flag bits, stored in the cell pass's attribute buffer. */
export const Flags = {
  landmark: 1,
  /** A road drawn as a strip of its real width (Place level), not as a 1-cell line. */
  corridor: 2,
  crossing: 4,
  /** A pitched roof: the vertex carries its signed distance to the ridge, and the ridge angle. */
  ridged: 32,
} as const;

/** Tree kinds by variant byte (the pipeline's `variant`); 0 is unknown. */
export const TREE_KINDS = ['palm', 'needleleaved', 'broadleaved'] as const;

/**
 * The per-vertex variant byte from the pipeline's `variant` property: which furniture glyph to
 * draw, a tree's or wood's kind (`TREE_KINDS` + 1), a building's roof (1 = flat,
 * 2 = pitched), or a siding (1: a track's `siding`, `spur`, or `yard`). 0 is unknown.
 */
export function variantCode(className: string, variant: unknown): number {
  if (typeof variant !== 'string') return 0;
  if (className === 'furniture')
    return (
      [
        'bench',
        'fountain',
        'flagpole',
        'stop',
        'terminal',
        'shelter',
        'crossing',
        'signals',
      ].indexOf(variant) + 1
    );
  if (className === 'tree' || className === 'trees') {
    return (TREE_KINDS as readonly string[]).indexOf(variant) + 1;
  }
  if (className.startsWith('building')) return variant === 'flat' ? 1 : 2;
  // A siding, spur, or yard track, where trains stand by.
  if (className === 'rail') return 1;
  return 0;
}
