/**
 * Glyph selection rules (ARCHITECTURE.md §4). The select shader (`shaders/select.ts`) implements
 * the same formulas on the GPU; these CPU versions build its lookup tables and are unit-tested.
 */
import { classId, MAX_CLASSES, renderClasses, type RenderClass } from '../classes';
import {
  buildingRamp,
  doubleWall,
  sextantGlyphs,
  singleWall,
  type GlyphKind,
  type Theme,
} from '../theme';

/** Numeric kind codes shared with the select shader. 0 means "not drawn". */
export const kindCodes: Record<GlyphKind, number> = {
  road: 1,
  water: 2,
  building: 3,
  diagonal: 4,
  rows: 5,
  scatter: 6,
  single: 7,
  variant: 8,
  ramp: 9,
  grass: 10,
  canopy: 11,
  foliage: 12,
  crop: 13,
};

/** Width of the glyph table: the most variants any class can have. */
export const MAX_VARIANTS = 32;

/** Connectivity bits, with north toward the top of the screen. */
export const Dir = { N: 1, E: 2, S: 4, W: 8 } as const;
/** Road variants past the 16 masks: an isolated diagonal step. */
export const RISING = 16; // ╱ (neighbor to the NE or SW)
export const FALLING = 17; // ╲ (neighbor to the NW or SE)

/**
 * Outlines at close zoom (SPEC.md §2 Place level): curated landmarks get walls from
 * `landmark`, every other building from `building`.
 */
export const OUTLINE_ZOOM = { landmark: 17, building: 18 } as const;

/** Glyph-table rows past the classes that hold the wall glyphs (indexed by wall mask). */
export const WALL_SINGLE_ROW = MAX_CLASSES - 2;
export const WALL_DOUBLE_ROW = MAX_CLASSES - 1;
/**
 * Glyph-table row for 3D extras: the `░▒▓█` ramp for 3D buildings (variants 0–3), then roof
 * ridges `─ ╲ │ ╱` (variants 4–7), then a tree's trunk (variant 8).
 */
export const EXTRUDE_ROW = MAX_CLASSES - 3;
export const RIDGE_VARIANT = 4;
export const ridgeGlyphs = ['─', '╲', '│', '╱'] as const;
export const TRUNK_VARIANT = 8;
export const trunkGlyph = '│';

/** Glyph-table rows for the sextants (two rows of 32, indexed by mask). */
export const SEXTANT_ROW = MAX_CLASSES - 5;

/**
 * Sub-cell edges (SPEC.md §4 "Edges"): flat views also rasterize the map at `SUB.cols × SUB.rows`
 * samples per cell. Where an area's edge crosses a cell, the cell draws the sextant of the
 * samples inside the area, so footprints and shores keep their shape at a sixth of a cell.
 */
export const SUB = { cols: 2, rows: 3 } as const;

/** Classes whose edges are drawn with sextants: areas, not lines or markers. */
export const subcellClasses: readonly RenderClass[] = [
  'building',
  'building_religious',
  'building_school',
  'building_market',
  'building_part',
  'water_area',
  'water_sea',
  'park',
  'trees',
  'grass',
  'tree_crown',
  'farmland',
  'parking',
  'pitch',
];

/** Per class id, 1 for `subcellClasses`, for the select shader (ids past 31 included). */
export function subcellAreas(): Int32Array {
  const areas = new Int32Array(MAX_CLASSES);
  for (const cls of subcellClasses) areas[classId(cls)] = 1;
  return areas;
}

/**
 * A cell's sextant mask: bit `row * 2 + col` is set where that sample belongs to the feature
 * (`inside(col, row)`, rows from the top).
 */
export function sextantMask(inside: (col: number, row: number) => boolean): number {
  let mask = 0;
  for (let row = 0; row < SUB.rows; row++) {
    for (let col = 0; col < SUB.cols; col++)
      if (inside(col, row)) mask |= 1 << (row * SUB.cols + col);
  }
  return mask;
}

/** A mask on the feature's edge: some samples in, some out. Full and empty cells keep their glyph. */
export const isEdgeMask = (mask: number): boolean => mask !== 0 && mask !== 63;

/** Bit in the select pass's state byte for a sub-cell edge (above picking.ts `CellState`). */
export const EDGE_STATE = 4;

/**
 * Shadows (SPEC.md §4, flat views): a cell looks toward the sun `steps` cell widths; it is in
 * shadow if something there stands taller than it by more than the sun rises over that
 * distance. Shaded cells (`SHADOW_STATE` in the select pass's state byte) draw `dark` darker.
 */
export const SHADOW = { steps: 6, dark: 0.5 } as const;
export const SHADOW_STATE = 16;

/**
 * Whether a cell `selfHeight` meters tall is in shadow: `heightAt(k)` is the height standing
 * `k` steps of `stepMeters` toward the sun, and `sunTan` the tangent of the sun's altitude
 * (≤ 0: no sun, no shadows).
 */
export function inShadow(
  selfHeight: number,
  heightAt: (k: number) => number,
  sunTan: number,
  stepMeters: number,
): boolean {
  if (sunTan <= 0) return false;
  for (let k = 1; k <= SHADOW.steps; k++) {
    const h = heightAt(k);
    if (h > 0 && h - selfHeight >= k * stepMeters * sunTan) return true;
  }
  return false;
}

/** An edge's sextant is drawn this far from the feature's fill toward its glyph color, 0–1. */
export const EDGE_INK = 0.4;

/** One raster sample: its class (null for none), feature id, and height (0 for grounds). */
export type Sample = { cls: RenderClass | null; id: number; height?: number };

export type SubcellEdge = {
  /** The feature the sextant draws. */
  fg: Sample;
  mask: number;
  /** The class under the rest of the cell, whose fill shows there (null for none). */
  bg: RenderClass | null;
};

/** A building standing (not grounds, which have no height). */
const isBuilding = (s: Sample) => s.cls !== null && s.cls.startsWith('building') && s.height !== 0;

/**
 * A cell's sub-cell edge, or null if it keeps its glyph. `center` is the cell pass's winner,
 * `samples` the cell's `SUB` samples in mask-bit order, and `outlined` whether a sample's
 * feature is drawn with walls at this zoom (walls trace its edge instead).
 *
 * Only an empty cell or an area (`subcellClasses`) takes part: lines and markers win their cells
 * whole. The sextant draws the cell's own area, unless it isn't a building and a sample is:
 * buildings keep their shape over the grounds, parks, and water they stand in.
 */
export function subcellEdge(
  center: Sample,
  samples: readonly Sample[],
  outlined: (sample: Sample) => boolean,
): SubcellEdge | null {
  const isArea = (s: Sample) => s.cls !== null && subcellClasses.includes(s.cls);
  if (center.cls !== null && !isArea(center)) return null;
  let fg: Sample | null = isArea(center) ? center : null;
  for (const s of samples) {
    if (isArea(s) && (fg === null || (!isBuilding(fg) && isBuilding(s)))) fg = s;
  }
  if (fg === null || outlined(fg)) return null;
  const { id } = fg;
  const mask = sextantMask((col, row) => samples[row * SUB.cols + col]!.id === id);
  if (!isEdgeMask(mask)) return null;
  // The rest of the cell shows the first other class there, if any.
  const bg = samples.find((s) => s.id !== id && s.cls !== null)?.cls ?? null;
  return { fg, mask, bg };
}

/** Roof code per cell (the attribute buffer's alpha): which slope, or the ridge. */
export const RoofCode = { none: 0, lit: 1, shaded: 2, ridge: 3 } as const;

/**
 * A pitched-roof cell: on the ridge if the ridge line passes through it (|distance| within half
 * the distance's change across one cell), else the lit or shaded slope. The cell shader does
 * the same with `fwidth`.
 */
export function roofCode(distance: number, changePerCell: number): number {
  if (Math.abs(distance) <= 0.5 * changePerCell) return RoofCode.ridge;
  return distance > 0 ? RoofCode.lit : RoofCode.shaded;
}

/**
 * Which of `─ ╲ │ ╱` draws a ridge at `angleByte` (0–255 over 0–180°, y down), judged in cell
 * units (`aspect` = cell height ÷ width), since the diagonals run corner to corner of a cell.
 */
export function ridgeVariant(angleByte: number, aspect: number): number {
  const theta = (angleByte / 255) * Math.PI;
  const phi = Math.atan2(Math.sin(theta) / aspect, Math.cos(theta)); // 0..π
  const bin = Math.round(phi / (Math.PI / 4)) % 4;
  return RIDGE_VARIANT + bin;
}

/**
 * A roof cell's glyph variant in the building row (lit ▓, shaded ▒, ridge by angle), or null
 * where there is no ridge (flat roofs, landmark parts) and the height ramp stays.
 */
export function roofVariant(code: number, angleByte: number, aspect: number): number | null {
  if (code === RoofCode.none) return null;
  if (code === RoofCode.ridge) return ridgeVariant(angleByte, aspect);
  return code === RoofCode.shaded ? 1 : 2;
}

/** Wall shade thresholds (0–255) between `░`, `▒`, and `▓`. */
export const WALL_SHADE_STEPS = [85, 170] as const;

/**
 * A 3D building cell's glyph in the extrusion row: roofs are solid `█`; walls step `░▒▓`
 * with how directly they face the light (the shade byte).
 */
export function extrusionVariant(shade: number, roof: boolean): number {
  if (roof) return 3;
  const step = WALL_SHADE_STEPS.findIndex((limit) => shade < limit);
  return step === -1 ? WALL_SHADE_STEPS.length : step;
}

export type WallStyle = 'single' | 'double';

/**
 * Which wall set a cell uses, if any, from its kind, landmark flag, height, and the zoom.
 * Grounds (building classes without a height, e.g. a campus) are never outlined: everything
 * inside them would get a ring of wall around it.
 */
export function wallStyle(
  kind: GlyphKind,
  landmark: boolean,
  height: number,
  zoom: number,
): WallStyle | null {
  if (landmark && zoom >= OUTLINE_ZOOM.landmark) return kind === 'building' ? 'double' : 'single';
  if (kind === 'building' && height > 0 && zoom >= OUTLINE_ZOOM.building) return 'single';
  return null;
}

/**
 * The wall mask of a cell in a feature, or null if the cell is inside (not on the outline).
 * `outside(dx, dy)` says whether the neighbor at that offset belongs to another feature (one
 * not in `seeThrough`).
 *
 * A cell is on the outline if any of its 8 neighbors is outside. It joins its neighbor in a
 * direction when that neighbor is in the feature and a cell touching both is outside: the two
 * share a stretch of edge. That draws straight walls, convex and concave corners, and no false
 * junctions where a feature is only two cells thick.
 */
export function wallMask(outside: (dx: number, dy: number) => boolean): number | null {
  let edge = false;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && outside(dx, dy)) edge = true;
  }
  if (!edge) return null;
  const joins = (dx: number, dy: number, sides: [number, number][]) =>
    !outside(dx, dy) && sides.some(([sx, sy]) => outside(sx, sy));
  // prettier-ignore
  return (
    (joins(0, -1, [[-1, 0], [-1, -1], [1, 0], [1, -1]]) ? Dir.N : 0) |
    (joins(1, 0, [[0, -1], [1, -1], [0, 1], [1, 1]]) ? Dir.E : 0) |
    (joins(0, 1, [[-1, 0], [-1, 1], [1, 0], [1, 1]]) ? Dir.S : 0) |
    (joins(-1, 0, [[0, -1], [-1, -1], [0, 1], [-1, 1]]) ? Dir.W : 0)
  );
}

/**
 * Classes an outline looks through: footpaths, statues, and markers usually sit inside a plaza
 * or grounds, so they don't count as "outside" when tracing its walls.
 */
export const seeThrough: readonly RenderClass[] = [
  'path',
  'barrier',
  'tree',
  'furniture',
  'entrance',
  'monument',
  'marker_religious',
  'marker_school',
  'marker_market',
  'marker_landmark',
  // Admin boundaries cross buildings and roads without being part of either.
  'admin_city',
  'admin_subdivision',
];

/** A class's bit in the shader's 32-bit class masks (connectivity, see-through). */
function classBit(cls: RenderClass): number {
  const id = classId(cls);
  if (id > 31) throw new Error(`class ${cls} (id ${id}) does not fit a 32-bit class mask`);
  return 1 << id; // bit 31 is the sign bit; masks are tested with shifts, so it still works
}

/** Bitmask of the carriageway class ids, for the cell and select shaders. */
export const roadMask = (): number => roadClasses.reduce((mask, cls) => mask | classBit(cls), 0);

/** Bitmask of `seeThrough` class ids, for the select shader. */
export const seeThroughMask = (): number =>
  seeThrough.reduce((mask, cls) => mask | classBit(cls), 0);

/** The wall glyph for a mask (`□` for a lone cell). */
export const wallGlyph = (style: WallStyle, mask: number): string =>
  (style === 'double' ? doubleWall : singleWall)[mask]!;

/** How fast each water cell flips between its glyphs, in flips per second. */
export const WATER_RATE = 0.5;

/** Carriageways: they connect to each other, and become strips with curbs at Place level. */
export const roadClasses: readonly RenderClass[] = ['road_major', 'road_mid', 'road_minor'];
const connectsTo: Partial<Record<RenderClass, readonly RenderClass[]>> = {
  road_major: roadClasses,
  road_mid: roadClasses,
  road_minor: roadClasses,
  path: [...roadClasses, 'path'],
  barrier: ['barrier'],
  coastline: ['coastline'],
  admin_city: ['admin_city'],
  admin_subdivision: ['admin_subdivision', 'admin_city'],
};

/**
 * From this zoom, carriageways are drawn at their real width with curbs (`wallMask` where
 * "outside" is anything but road), instead of as 1-cell box-drawing lines.
 */
export const ROAD_AREA_ZOOM = 18;

/** From this zoom, pitched roofs show their ridge and lit/shaded slopes (flat roofs stay solid). */
export const ROOF_ZOOM = 19;

export const connects = (cls: RenderClass, neighbor: RenderClass | null): boolean =>
  neighbor !== null && (connectsTo[cls]?.includes(neighbor) ?? false);

/**
 * The road variant from its orthogonal mask and diagonal neighbors. Any orthogonal neighbor
 * wins; a cell joined only diagonally (an 8-connected line step) gets `╱` or `╲`.
 */
export function roadVariant(mask: number, rising: boolean, falling: boolean): number {
  if (mask !== 0) return mask;
  if (rising) return RISING;
  if (falling) return FALLING;
  return 0;
}

/** Height thresholds (meters) between the steps of the building ramp. */
export const BUILDING_STEPS = [3, 7, 12] as const;

/** Building ramp index from height in meters. */
export function buildingVariant(height: number): number {
  const step = BUILDING_STEPS.findIndex((limit) => height < limit);
  return step === -1 ? BUILDING_STEPS.length : step;
}

/**
 * A ramp class's variant from its height byte: terrain bands are numbered from 1 (the lowest,
 * the first glyph) in the pipeline (`lib/terrain.ts`).
 */
export const rampVariant = (height: number, count: number): number =>
  Math.max(0, Math.min(count - 1, Math.round(height) - 1));

/** A 32-bit integer hash of a world cell, identical to `cellHash` in the select shader. */
export function cellHash(x: number, y: number): number {
  let h = (Math.imul(x, 0x8da6b343) ^ Math.imul(y, 0xd8163841)) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995) >>> 0;
  h ^= h >>> 15;
  return h >>> 0;
}

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** Water alternates glyphs; each cell flips at its own phase. `time` is 0 with reduced motion. */
export function waterVariant(x: number, y: number, time: number, gust = 0): number {
  // A gust ruffles the water in its bands: the strong part one glyph, the edges the other, so
  // the band reads as it runs downwind (`gust` already scaled by the wind).
  if (gust >= GUST_STEPS[0]) return gust >= GUST_STEPS[1] ? 0 : 1;
  const h = cellHash(x, y);
  const phase = ((h >>> 8) & 255) / 255;
  return (h + Math.floor(time * WATER_RATE + phase)) % 2;
}

/**
 * Thin water: a water style with `WATER_STROKE_GLYPHS` glyphs (rivers and streams) draws a
 * 1-cell-wide run that isn't horizontal as a stroke, so it reads as a line rather than a trail
 * of `~`: glyphs 2–3 alternate by row down a vertical run (`(` `)`), 4 and 5 are the rising and
 * falling diagonals. Horizontal runs and wider water keep the animated glyphs 0–1.
 */
export const WATER_STROKE_GLYPHS = 6;
export const WaterStroke = { vertical: 2, rising: 4, falling: 5 } as const;

/** Classes drawn as water, which a thin run's neighbors are checked against. */
export const waterClasses: readonly RenderClass[] = [
  'water_river',
  'water_stream',
  'water_area',
  'water_sea',
];

/**
 * The stroke variant of a thin water cell from which neighbors are water, or null when the cell
 * isn't a stroke (a horizontal run, a wider area, or a lone cell) and animates instead.
 */
export function waterStrokeVariant(
  water: (dx: number, dy: number) => boolean,
  y: number,
): number | null {
  const horizontal = water(1, 0) || water(-1, 0);
  const vertical = water(0, -1) || water(0, 1);
  if (vertical && !horizontal) return WaterStroke.vertical + mod(y, 2);
  if (vertical || horizontal) return null;
  if (water(1, -1) || water(-1, 1)) return WaterStroke.rising;
  if (water(-1, -1) || water(1, 1)) return WaterStroke.falling;
  return null;
}

const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/**
 * Value noise over world cells, 0–1: hashed values on a lattice every `scale` cells, smoothly
 * interpolated. `seed` picks an independent field. Integers until the last step, so large world
 * coordinates stay exact (the GLSL twin is `valueNoise` in shaders/hash.ts).
 */
export function valueNoise(x: number, y: number, scale: number, seed: number): number {
  const ix = Math.floor(x / scale);
  const iy = Math.floor(y / scale);
  const fx = mod(x, scale) / scale;
  const fy = mod(y, scale) / scale;
  const at = (dx: number, dy: number) =>
    (cellHash(ix + dx + seed * 7919, iy + dy - seed * 104729) >>> 8) / 16777216;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const top = at(0, 0) + (at(1, 0) - at(0, 0)) * sx;
  const bottom = at(0, 1) + (at(1, 1) - at(0, 1)) * sx;
  return top + (bottom - top) * sy;
}

/**
 * Wind over grass and parks (SPEC.md §4): fronts sweep downwind across the map, bent by noise,
 * and blow in patches that come and go, so a gust ripples through part of a park at a time.
 */
export const WIND = {
  /** Cells (along the wind) from one front to the next. */
  period: 56,
  /** Cells per second a front travels. */
  speed: 7,
  /** How far noise bends a front, in periods, and the noise's scale in cells. */
  bend: 0.35,
  bendScale: 20,
  /** Size of the patches gusts blow in, in cells, and how fast they change, per second. */
  patchScale: 48,
  drift: 0.05,
  /**
   * World cells are taken modulo this before the fronts are laid out along the wind, so the
   * math stays exact in float32 at any zoom; a front has a seam only every `wrap` cells.
   */
  wrap: 4096,
} as const;

/** Where the wind blows: a unit vector in world cells (x east, y south). */
export type WindDir = readonly [number, number];

/** The wind blowing from `degrees` (compass: 0 north, 90 east), as the way it blows. */
export function windFrom(degrees: number): WindDir {
  const toward = ((degrees + 180) * Math.PI) / 180;
  return [Math.sin(toward), -Math.cos(toward)];
}

/** The direction when none is given: from the northeast. */
export const DEFAULT_WIND_DIR = windFrom(45);

/** How strong the wind is at a world cell, 0 (still) to 1 (a gust's crest). */
export function windGust(
  x: number,
  y: number,
  time: number,
  dir: WindDir = DEFAULT_WIND_DIR,
): number {
  const { period, speed, wrap } = WIND;
  const along = (mod(x, wrap) * dir[0] + mod(y, wrap) * dir[1]) / period;
  const travel = (time * speed) / period;
  const s = along - (travel - Math.floor(travel)) + WIND.bend * valueNoise(x, y, WIND.bendScale, 0);
  const band = smoothstep(0.7, 1, 0.5 + 0.5 * Math.sin(2 * Math.PI * s));
  const k = time * WIND.drift;
  const k0 = Math.floor(k);
  const kf = smoothstep(0, 1, k - k0);
  const a = valueNoise(x, y, WIND.patchScale, 1 + k0);
  const b = valueNoise(x, y, WIND.patchScale, 2 + k0);
  return band * smoothstep(0.35, 0.65, a + (b - a) * kf);
}

/** A gust this strong bends grass over, and this strong flattens it. */
export const GUST_STEPS = [0.3, 0.8] as const;
/** Grass glyphs by role (theme.ts `grassGlyphs`). */
export const GrassGlyph = { leanRight: 3, leanLeft: 4, flat: 5 } as const;

/**
 * A grass cell's glyph: the park pattern at rest; in a gust, leaning downwind, then flat.
 * `wind` scales the gusts (0 with reduced motion), which blow along `dir`.
 */
export function grassVariant(
  x: number,
  y: number,
  time: number,
  wind = 1,
  dir: WindDir = DEFAULT_WIND_DIR,
): number {
  const gust = wind * windGust(x, y, time, dir);
  if (gust < GUST_STEPS[0]) return mod(x + y, 3);
  if (gust < GUST_STEPS[1]) return dir[0] >= 0 ? GrassGlyph.leanRight : GrassGlyph.leanLeft;
  return GrassGlyph.flat;
}

/** Crop glyphs by role (theme.ts `farmland`): rows at rest, then leaning right, left, and flat. */
export const CropGlyph = { leanRight: 2, leanLeft: 3, flat: 4 } as const;

/**
 * A field's glyph: rows by `y` at rest; in a gust (`gust`, already scaled by the wind, blowing
 * along `dir`) the crop rows lean downwind and the furrows ripple, so the wave runs across them.
 */
export function cropVariant(y: number, gust = 0, dir: WindDir = DEFAULT_WIND_DIR): number {
  const row = mod(y, 2);
  if (gust < GUST_STEPS[0]) return row;
  if (row === 0 || gust >= GUST_STEPS[1]) return CropGlyph.flat;
  return dir[0] >= 0 ? CropGlyph.leanRight : CropGlyph.leanLeft;
}

/**
 * Trees in the same wind: heavier than grass, they catch a gust `lag` seconds after the grass
 * under them, and only a stronger one (`step`). Their branches swing (`SWAY`) and their leaves
 * flutter (`FLUTTER`).
 */
export const TREE_WIND = { lag: 0.35, step: 0.4 } as const;

/** How strong the wind is in a tree's crown at a world cell, 0–1. */
export const treeGust = (
  x: number,
  y: number,
  time: number,
  dir: WindDir = DEFAULT_WIND_DIR,
): number => windGust(x, y, time - TREE_WIND.lag, dir);

/**
 * Bit in the select pass's state byte (above `EDGE_STATE`) for grass bent over by a gust: the
 * glyph pass draws it a little lighter, the blades' pale sides catching the light.
 */
export const WIND_STATE = 8;
/** How far a gust lightens a lit cell's glyph toward white, 0–1. */
export const WIND_LIGHT = 0.3;

/** Whether a gust lights a grass cell: bent over or flat. */
export const windLit = (gust: number): boolean => gust >= GUST_STEPS[0];

/**
 * How a crown's branches swing (cells; the cell shader moves each vertex of a crown): downwind
 * by `bend` × its reach from the trunk (so the tips swing most), at most `max`, and a flutter
 * of `flutter` across the wind at `rate` radians per second, each vertex at its own phase. A
 * standing crown swings fully at its top and by `standingBase` at its bottom.
 */
export const SWAY = { bend: 0.3, max: 3, flutter: 0.5, rate: 7, standingBase: 0.4 } as const;

/**
 * How far (cells, [x, y]) a crown vertex `reach` cells from its trunk swings in a gust (`gust`,
 * already scaled by the wind) at `time`: the CPU twin of the cell shader's sway.
 */
export function swayOffset(
  reach: number,
  gust: number,
  time: number,
  phase: number,
  dir: WindDir = DEFAULT_WIND_DIR,
): [number, number] {
  const [dx, dy] = dir;
  const along = gust * Math.min(SWAY.bend * reach, SWAY.max);
  const across = gust * SWAY.flutter * Math.min(reach / 2, 1) * Math.sin(time * SWAY.rate + phase);
  return [dx * along - dy * across, dy * along + dx * across];
}

/** Leaves flutter in a gust: they flip this often per second, more in a stronger one. */
export const FLUTTER = { rate: 3 } as const;

/** Whether a fluttering leaf cell shows its other glyph at `time` (it flips back and forth). */
function flutters(h: number, gust: number, time: number): boolean {
  const phase = ((h >>> 8) & 255) / 256;
  const flips = Math.floor(time * FLUTTER.rate * (0.5 + gust) + phase);
  return (((h >>> 2) + flips) & 1) === 1;
}

/**
 * A crown cell's glyph (theme.ts `tree_crown`): a hashed pick of the leaves at rest; in a gust
 * (`gust`, already scaled by the wind), the leaves flutter, flipping between `%` and `&`.
 */
export function foliageVariant(x: number, y: number, time = 0, gust = 0): number {
  const h = cellHash(x, y);
  if (gust >= TREE_WIND.step) return flutters(h, gust, time) ? 0 : 1;
  return h % 4;
}

/**
 * Woods as clumped crowns (SPEC.md §4): a crown per `cols × rows` block of cells, centered on a
 * hashed cell of the block. A cell farther than `clearing` (in blocks) from every center is a
 * clearing with chance `gaps`. In a gust the whole pattern leans downwind by up to `sway` cells.
 */
export const CANOPY = { cols: 4, rows: 2, clearing: 0.65, gaps: 0.5, sway: 1.5 } as const;
/** Canopy glyphs by role (theme.ts `trees`); `rustle` is the foliage's other glyph in a gust. */
export const CanopyGlyph = { foliage: 3, gap: 4, palm: 5, needle: 6, rustle: 8 } as const;

/** The woods' pattern at a world cell: a crown's center, foliage, or a clearing. */
function canopyShape(x: number, y: number, variant: number): number {
  const { cols, rows } = CANOPY;
  const gx = Math.floor(x / cols);
  const gy = Math.floor(y / rows);
  let best = Infinity;
  let bestHash = 0;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const h = cellHash(gx + ox, gy + oy);
      const dx = (x - ((gx + ox) * cols + (h % cols))) / cols;
      const dy = (y - ((gy + oy) * rows + ((h >>> 8) % rows))) / rows;
      const d = dx * dx + dy * dy;
      if (d < best) {
        best = d;
        bestHash = h;
      }
    }
  }
  if (best === 0) {
    if (variant === 1) return CanopyGlyph.palm;
    if (variant === 2) return CanopyGlyph.needle + ((bestHash >>> 16) & 1);
    return (bestHash >>> 16) % 3;
  }
  const clearing = best > CANOPY.clearing * CANOPY.clearing;
  if (clearing && ((cellHash(x, y) >>> 8) & 255) < CANOPY.gaps * 256) return CanopyGlyph.gap;
  return CanopyGlyph.foliage;
}

/** How many cells the woods' pattern leans downwind in a gust (already scaled by the wind). */
export const canopyShift = (gust: number): number =>
  gust >= TREE_WIND.step ? Math.round(gust * CANOPY.sway) : 0;

/**
 * A canopy cell's glyph: at a crown's center, by the wood's kind (`variant`, classes.ts
 * `TREE_KINDS` + 1), else one of three by the crown's hash; around it, foliage or a clearing.
 * In a gust (`gust`, already scaled by the wind) the crowns lean downwind with it (the pattern
 * is read from upwind) and their foliage flutters.
 */
export function canopyVariant(
  x: number,
  y: number,
  variant = 0,
  gust = 0,
  time = 0,
  dir: WindDir = DEFAULT_WIND_DIR,
): number {
  const shift = canopyShift(gust);
  const sx = x - Math.round(dir[0] * shift);
  const sy = y - Math.round(dir[1] * shift);
  const v = canopyShape(sx, sy, variant);
  if (v === CanopyGlyph.foliage && gust >= TREE_WIND.step && flutters(cellHash(x, y), gust, time)) {
    return CanopyGlyph.rustle;
  }
  return v;
}

/** Area patterns, from world cell coordinates so they stay put while panning. */
export function patternVariant(
  kind: 'diagonal' | 'rows' | 'scatter',
  x: number,
  y: number,
  count: number,
): number {
  if (kind === 'diagonal') return mod(x + y, count);
  if (kind === 'rows') return mod(y, count);
  return cellHash(x, y) % count;
}

export type CellContext = {
  /** World cell coordinates (the grid is anchored to the world, not the screen). */
  x: number;
  y: number;
  /** Building height in meters (the attribute buffer's height byte). */
  height: number;
  /** The class in the neighboring cell at offset (dx, dy), y pointing down. */
  neighbor: (dx: number, dy: number) => RenderClass | null;
  /** Seconds, for water and wind. */
  time: number;
  /** How hard the wind blows over grass (0 with reduced motion); default 1. */
  wind?: number;
  /** Where the wind blows (a unit vector); default from the northeast. */
  windDir?: WindDir;
  /** The feature's variant byte (classes.ts `variantCode`). */
  variant?: number;
};

/** The variant a class with `count` glyphs shows in a cell: the CPU twin of the select shader. */
export function variantFor(
  kind: GlyphKind,
  cls: RenderClass,
  count: number,
  ctx: CellContext,
): number {
  switch (kind) {
    case 'road': {
      const at = (dx: number, dy: number) => connects(cls, ctx.neighbor(dx, dy));
      const mask =
        (at(0, -1) ? Dir.N : 0) |
        (at(1, 0) ? Dir.E : 0) |
        (at(0, 1) ? Dir.S : 0) |
        (at(-1, 0) ? Dir.W : 0);
      return roadVariant(mask, at(1, -1) || at(-1, 1), at(-1, -1) || at(1, 1));
    }
    case 'water': {
      const isWater = (dx: number, dy: number) => {
        const n = ctx.neighbor(dx, dy);
        return n !== null && waterClasses.includes(n);
      };
      const stroke = count >= WATER_STROKE_GLYPHS ? waterStrokeVariant(isWater, ctx.y) : null;
      // Without a wind given, water just flips (its gust bands need the wind to be named).
      const gust = (ctx.wind ?? 0) * windGust(ctx.x, ctx.y, ctx.time, ctx.windDir);
      return stroke ?? waterVariant(ctx.x, ctx.y, ctx.time, gust);
    }
    case 'building':
      return buildingVariant(ctx.height);
    case 'diagonal':
    case 'rows':
    case 'scatter':
      return patternVariant(kind, ctx.x, ctx.y, count);
    case 'single':
      return 0;
    case 'variant':
      return Math.min(ctx.variant ?? 0, count - 1);
    case 'ramp':
      return rampVariant(ctx.height, count);
    case 'grass':
      return Math.min(grassVariant(ctx.x, ctx.y, ctx.time, ctx.wind, ctx.windDir), count - 1);
    case 'canopy': {
      const gust = (ctx.wind ?? 1) * treeGust(ctx.x, ctx.y, ctx.time, ctx.windDir);
      const v = canopyVariant(ctx.x, ctx.y, ctx.variant, gust, ctx.time, ctx.windDir);
      return Math.min(v, count - 1);
    }
    case 'crop': {
      const gust = (ctx.wind ?? 1) * windGust(ctx.x, ctx.y, ctx.time, ctx.windDir);
      return Math.min(cropVariant(ctx.y, gust, ctx.windDir), count - 1);
    }
    case 'foliage': {
      const gust = (ctx.wind ?? 1) * treeGust(ctx.x, ctx.y, ctx.time, ctx.windDir);
      return Math.min(foliageVariant(ctx.x, ctx.y, ctx.time, gust), count - 1);
    }
  }
}

/** The glyph a class shows in a cell under a theme, or null if the theme doesn't draw it. */
export function selectGlyph(theme: Theme, cls: RenderClass, ctx: CellContext): string | null {
  const style = theme.styles[cls];
  if (!style) return null;
  const variant = variantFor(style.kind, cls, style.glyphs.length, ctx);
  return style.glyphs[Math.min(variant, style.glyphs.length - 1)] ?? null;
}

export type GlyphTables = {
  /** R8, MAX_VARIANTS × MAX_CLASSES: glyph atlas index per (variant, class id). */
  table: Uint8Array;
  /** Kind code per class id (0 = not drawn). */
  kinds: Int32Array;
  /** Glyph count per class id. */
  counts: Int32Array;
  /** Bitmask of class ids each class id connects to (roads). */
  connects: Int32Array;
  /** Linear RGB per class id. */
  colors: Float32Array;
  /** Background fill strength per class id (theme.ts `ClassStyle.fill`, 0 = none). */
  fills: Float32Array;
};

/** Build the select shader's lookup tables from a theme and the glyph atlas's index. */
export function buildGlyphTables(theme: Theme, atlasIndex: (glyph: string) => number): GlyphTables {
  // The table is a byte texture, so map glyphs must come first in the atlas (theme.ts).
  const glyphIndex = (glyph: string) => {
    const index = atlasIndex(glyph);
    if (index > 255) throw new Error(`map glyph ${glyph} has atlas index ${index}, over 255`);
    return index;
  };
  const table = new Uint8Array(MAX_VARIANTS * MAX_CLASSES);
  const kinds = new Int32Array(MAX_CLASSES);
  const counts = new Int32Array(MAX_CLASSES);
  const connectMasks = new Int32Array(MAX_CLASSES);
  const colors = new Float32Array(MAX_CLASSES * 3);
  const fills = new Float32Array(MAX_CLASSES);

  for (const cls of renderClasses) {
    const id = classId(cls);
    const style = theme.styles[cls];
    if (!style) continue;
    kinds[id] = kindCodes[style.kind];
    counts[id] = style.glyphs.length;
    for (let v = 0; v < MAX_VARIANTS; v++) {
      const glyph = style.glyphs[Math.min(v, style.glyphs.length - 1)]!;
      table[id * MAX_VARIANTS + v] = glyphIndex(glyph);
    }
    for (const other of connectsTo[cls] ?? []) connectMasks[id]! |= classBit(other);
    colors[id * 3] = ((style.color >> 16) & 0xff) / 255;
    colors[id * 3 + 1] = ((style.color >> 8) & 0xff) / 255;
    colors[id * 3 + 2] = (style.color & 0xff) / 255;
    fills[id] = style.fill ?? 0;
  }
  buildingRamp.forEach((glyph, v) => {
    table[EXTRUDE_ROW * MAX_VARIANTS + v] = glyphIndex(glyph);
  });
  ridgeGlyphs.forEach((glyph, i) => {
    table[EXTRUDE_ROW * MAX_VARIANTS + RIDGE_VARIANT + i] = glyphIndex(glyph);
  });
  table[EXTRUDE_ROW * MAX_VARIANTS + TRUNK_VARIANT] = glyphIndex(trunkGlyph);
  for (let mask = 0; mask < 16; mask++) {
    table[WALL_SINGLE_ROW * MAX_VARIANTS + mask] = glyphIndex(wallGlyph('single', mask));
    table[WALL_DOUBLE_ROW * MAX_VARIANTS + mask] = glyphIndex(wallGlyph('double', mask));
  }
  sextantGlyphs.forEach((glyph, mask) => {
    table[SEXTANT_ROW * MAX_VARIANTS + mask] = glyphIndex(glyph);
  });
  return { table, kinds, counts, connects: connectMasks, colors, fills };
}
