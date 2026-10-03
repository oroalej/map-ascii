/**
 * Glyph selection rules (ARCHITECTURE.md §4). The select shader (`shaders/select.ts`) implements
 * the same formulas on the GPU; these CPU versions build its lookup tables and are unit-tested.
 */
import {
  classId,
  Flags,
  Marking,
  markingOf,
  MAX_CLASSES,
  PavingVariant,
  pavingOverrideBase,
  renderClasses,
  type RenderClass,
} from '../classes';
import {
  arrowGlyphs,
  doubleWall,
  sextantGlyphs,
  singleWall,
  type GlyphKind,
  type Theme,
} from '../theme';
import { RoofCode, roofSlopeVariant, roofSurfaceCode } from './roofs';
export { RoofCode, roofSlopeVariant, roofSurfaceCode } from './roofs';

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
  seating: 14,
  planting: 15,
};

/** Width of the glyph table: the most variants any class can have. */
export const MAX_VARIANTS = 32;

export const GLYPH_BITS = 10;
/** Highest index; slot zero is blank. */
export const MAX_GLYPHS = (1 << GLYPH_BITS) - 1;
/** RGBA8 map/life texels share the class byte with the glyph's two high bits. */
export const packGlyph = (glyph: number, cls: number) =>
  [glyph & 255, (cls & 63) | ((glyph >> 8) << 6)] as const;
export const unpackGlyph = (lo: number, clsByte: number) => ({
  glyph: lo | ((clsByte >> 6) << 8),
  cls: clsByte & 63,
});
/** Decode one RG8 lookup-table entry (not a packed class byte). */
export const tableGlyph = (table: Uint8Array, entry: number) =>
  table[entry * 2]! | (table[entry * 2 + 1]! << 8);

/** Connectivity bits, with north toward the top of the screen. */
export const Dir = { N: 1, E: 2, S: 4, W: 8 } as const;
/** First outside side with mapped street/path adjacency within three cells, N/E/S/W order. */
export function awningSide(
  outside: readonly boolean[],
  streetAt: (side: number, distance: number) => boolean,
  blockedAt: (side: number, distance: number) => boolean = () => false,
): number {
  for (let side = 0; side < 4; side++)
    if (outside[side])
      for (let distance = 1; distance <= 3; distance++) {
        if (streetAt(side, distance)) return side;
        if (blockedAt(side, distance)) break;
      }
  return -1;
}
export const awningCode = (kind: number, parity: number) => 1 + kind * 2 + (parity & 1);
/** Stripe orientation and fine-scale alternation, matching the select shader. */
export function crossingGlyph(bearingByte: number, cellMeters: number, parity: number): string {
  if (cellMeters < 1.2 && parity & 1) return ' ';
  const axis = bearingByte & 31;
  return axis < 8 || axis >= 24 ? '═' : '║';
}
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
 * Glyph-table row for roof ridges `─ ╲ │ ╱` (variants 4–7, so a ridge variant never collides
 * with the lit ▓ and shaded ▒ slopes, variants 1–2 of the building's own row).
 */
export const ROOF_ROW = MAX_CLASSES - 3;
export const RIDGE_VARIANT = 4;
export const ARROW_VARIANT = 8;
export const ridgeGlyphs = ['─', '╲', '│', '╱'] as const;

/** Bearing is clockwise from north; compensate for the cell grid's taller characters. */
export function arrowVariant(bearing: number, aspect: number): number {
  const theta = (bearing * Math.PI) / 180;
  const angle = Math.atan2(Math.sin(theta), Math.cos(theta) / aspect);
  return ARROW_VARIANT + (((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8);
}

export function markingGlyph(
  byte: number,
  cellMeters: number,
  parity: number,
  aspect: number,
): string {
  const marking = markingOf(byte);
  if (marking.kind === Marking.crosswalk) return crossingGlyph(byte, cellMeters, parity);
  if (marking.kind === Marking.stop) {
    const axis = byte & 31;
    return axis < 8 || axis >= 24 ? '─' : '│';
  }
  return marking.kind === Marking.arrow
    ? arrowGlyphs[arrowVariant(marking.bearingDeg, aspect) - ARROW_VARIANT]!
    : ' ';
}

/** Curbs look through ordinary paths, but remain against a paved sidewalk band. */
export function curbOutside(cls: RenderClass | null, flags = 0): boolean {
  return (
    (flags & Flags.sidewalk) !== 0 ||
    cls === null ||
    (!roadClasses.includes(cls) && !seeThrough.includes(cls))
  );
}

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
  'building_hospital',
  'building_market',
  'building_station',
  'building_part',
  'building_woodwork',
  'water_area',
  'water_sea',
  'park',
  'trees',
  'grass',
  'tree_crown',
  'farmland',
  'parking',
  'pitch',
  'paving',
  'seating',
  'shrubs',
  'planting',
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

/**
 * The select pass's state byte (glyph texture, blue): bits 0–1 the picking.ts `CellState`, then
 * `EDGE_STATE`, `SHADOW_STATE`, the wind level (2 bits from `WIND_SHIFT`, `windLevel`), and the
 * tone (2 bits from `TONE_SHIFT`, `Tone`). All 8 bits are used.
 */

/** Bit in the select pass's state byte for a sub-cell edge (above picking.ts `CellState`). */
export const EDGE_STATE = 4;

/**
 * Shadows (SPEC.md §4, flat views): a cell looks toward the sun `steps` cell widths; it is in
 * shadow if something there stands taller than it by more than the sun rises over that
 * distance. Shaded cells (`SHADOW_STATE` in the select pass's state byte) draw `dark` darker.
 */
export const SHADOW = { steps: 6, dark: 0.5 } as const;
export const SHADOW_STATE = 8;

/** Where the wind level (0–3) and the tone (`Tone`) sit in the state byte. */
export const WIND_SHIFT = 4;
export const TONE_SHIFT = 6;

/**
 * A tint on a vegetation cell's ink and fill, relative to its class color so it suits either
 * theme: `shade` darker, `light` toward white, `dry` toward straw (a per-channel multiplier).
 */
export const Tone = { none: 0, shade: 1, light: 2, dry: 3 } as const;
export const TONE = { shade: 0.8, light: 0.22, dry: [1.25, 1.08, 0.6] } as const;

/** The CPU twin of the glyph pass's tint: `rgb` (0–1 channels) under `tone`. */
export function toneColor(rgb: readonly [number, number, number], tone: number) {
  const [r, g, b] = rgb;
  if (tone === Tone.shade) return [r * TONE.shade, g * TONE.shade, b * TONE.shade] as const;
  if (tone === Tone.light) {
    const mix = (c: number) => c + (1 - c) * TONE.light;
    return [mix(r), mix(g), mix(b)] as const;
  }
  if (tone === Tone.dry) {
    const [dr, dg, db] = TONE.dry;
    return [Math.min(1, r * dr), Math.min(1, g * dg), Math.min(1, b * db)] as const;
  }
  return [r, g, b] as const;
}

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
export type Sample = { cls: RenderClass | null; id: number; height?: number; variant?: number };

export type SubcellEdge = {
  /** The feature the sextant draws. */
  fg: Sample;
  mask: number;
  /** The class under the rest of the cell, whose fill shows there (null for none). */
  bg: RenderClass | null;
};

/** A building standing (not grounds, which have no height). */
const isBuilding = (s: Sample) => s.cls !== null && s.cls.startsWith('building') && s.height !== 0;

const isPavingOverride = (s: Sample) => s.cls === 'paving' && s.variant === PavingVariant.override;
const belowPavingOverride = (s: Sample) =>
  !isPavingOverride(s) &&
  s.cls !== null &&
  (pavingOverrideBase.includes(s.cls) || (s.cls.startsWith('building') && s.height === 0));

/** Crowns and roofs share height precedence at their edge; equal heights favor the roof. */
export function edgeForegroundWins(candidate: Sample, current: Sample): boolean {
  const crown = candidate.cls === 'tree_crown';
  const underCrown = current.cls === 'tree_crown';
  if (crown && (isBuilding(current) || underCrown))
    return (candidate.height ?? 0) > (current.height ?? 0);
  if (underCrown && isBuilding(candidate)) return (candidate.height ?? 0) >= (current.height ?? 0);
  if (isPavingOverride(candidate)) return belowPavingOverride(current);
  if (isPavingOverride(current)) return candidate.cls !== null && !belowPavingOverride(candidate);
  return crown || (!isBuilding(current) && isBuilding(candidate));
}

/**
 * A cell's sub-cell edge, or null if it keeps its glyph. `center` is the cell pass's winner,
 * `samples` the cell's `SUB` samples in mask-bit order, and `outlined` whether a sample's
 * feature is drawn with walls at this zoom (walls trace its edge instead).
 *
 * Lines and markers keep their cells, except a crown can reach into a road cell. Buildings
 * keep their shape over ground areas; crowns and roofs compare heights.
 */
export function subcellEdge(
  center: Sample,
  samples: readonly Sample[],
  outlined: (sample: Sample) => boolean,
  beforeOutline = false,
): SubcellEdge | null {
  const isArea = (s: Sample) => s.cls !== null && subcellClasses.includes(s.cls);
  // The shader's first pass is for road/roof crowns and non-area paving edges.
  // Outlined parks and terraces must reach their outline before the ordinary edge pass.
  if (
    beforeOutline &&
    center.cls !== null &&
    !roadClasses.includes(center.cls) &&
    !center.cls.startsWith('building') &&
    !(!isArea(center) && belowPavingOverride(center))
  )
    return null;
  if (
    center.cls !== null &&
    !isArea(center) &&
    !roadClasses.includes(center.cls) &&
    !(belowPavingOverride(center) && samples.some(isPavingOverride))
  )
    return null;
  let fg: Sample | null = isArea(center) ? center : null;
  for (const s of samples) {
    if (
      center.cls !== null &&
      !isArea(center) &&
      s.cls !== 'tree_crown' &&
      !(belowPavingOverride(center) && isPavingOverride(s))
    )
      continue;
    if (isArea(s) && (fg === null || edgeForegroundWins(s, fg))) fg = s;
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

/**
 * A pitched-roof cell: on the ridge if the ridge line passes through it (|distance| within half
 * the distance's change across one cell), else the lit or shaded slope. The cell shader does
 * the same with `fwidth`.
 */
export function roofCode(distance: number, changePerCell: number): number {
  return roofSurfaceCode([0, distance, 1, 0], changePerCell, changePerCell);
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
export function roofVariant(
  code: number,
  angleByte: number,
  aspect: number,
  sun: readonly [number, number] = DEFAULT_SUN,
): number | null {
  if (code === RoofCode.none) return null;
  if (code === RoofCode.ridge || code === RoofCode.hipPos || code === RoofCode.hipNeg)
    return ridgeVariant(angleByte, aspect);
  return roofSlopeVariant(code, angleByte, sun);
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
  terrace = false,
): WallStyle | null {
  if (terrace && zoom >= OUTLINE_ZOOM.building) return 'single';
  if (kind === 'seating' && zoom >= OUTLINE_ZOOM.building) return 'single';
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
  'marker_hospital',
  'marker_market',
  'marker_station',
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

/**
 * Open water: short crests (variant 1) drift east along each row over the resting glyph
 * (variant 0). Rows are offset and move at one of two speeds; some crests are left out.
 */
export const WATER_RIPPLE = {
  period: 10, // cells from one crest slot to the next along a row
  crest: 3, // cells in a crest
  speeds: [0.5, 0.25], // cells per second, picked per row
  salt: 0x9e37, // row hash is cellHash(y, salt), apart from the slot hash cellHash(slot, y)
} as const;

/** The drift speed of a row's crests, in cells per second. */
export const rippleSpeed = (y: number): number =>
  WATER_RIPPLE.speeds[cellHash(y, WATER_RIPPLE.salt) & 1]!;

/** Carriageways: they connect to each other, and become strips with curbs at Place level. */
export const roadClasses: readonly RenderClass[] = ['road_major', 'road_mid', 'road_minor'];
const connectsTo: Partial<Record<RenderClass, readonly RenderClass[]>> = {
  road_major: roadClasses,
  road_mid: roadClasses,
  road_minor: roadClasses,
  path: [...roadClasses, 'path'],
  barrier: ['barrier'],
  rail: ['rail'],
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

/** Water's short crests drift east along each row. `time` is 0 with reduced motion. */
export function waterVariant(x: number, y: number, time: number, gust = 0): number {
  // A gust ruffles the water in its bands: the strong part one glyph, the edges the other, so
  // the band reads as it runs downwind (`gust` already scaled by the wind).
  if (gust >= GUST_STEPS[0]) return gust >= GUST_STEPS[1] ? 0 : 1;
  const { period, crest } = WATER_RIPPLE;
  const row = cellHash(y, WATER_RIPPLE.salt);
  const shifted = x + ((row >>> 8) % period);
  const pos = mod(shifted, period) - time * rippleSpeed(y);
  const cycles = Math.floor(pos / period);
  const along = pos - cycles * period; // [0, period)
  const slot = Math.floor(shifted / period) + cycles;
  // About three in four slots carry a crest.
  return along < crest && (cellHash(slot, y) & 3) !== 0 ? 1 : 0;
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

/**
 * The wind at a world cell: `gust` from 0 (still) to 1 (a front's crest), and `wake`, 0–1, in the
 * stretch just behind a crest where the air settles again (a crown springs back there, the
 * blades lift). Most cells are in neither, so the patch noise (two thirds of the hashing) is
 * only paid where a front or its wake is.
 */
export function windFront(
  x: number,
  y: number,
  time: number,
  dir: WindDir = DEFAULT_WIND_DIR,
): { gust: number; wake: number } {
  const { period, speed, wrap } = WIND;
  const along = (mod(x, wrap) * dir[0] + mod(y, wrap) * dir[1]) / period;
  const travel = (time * speed) / period;
  const s = along - (travel - Math.floor(travel)) + WIND.bend * valueNoise(x, y, WIND.bendScale, 0);
  const phase = 2 * Math.PI * s;
  const v = 0.5 + 0.5 * Math.sin(phase);
  const band = smoothstep(0.7, 1, v);
  // Behind the crest (a cell's phase falls as the front passes): from v = 0.7 down to 0.2.
  const behind = Math.cos(phase) > 0 ? smoothstep(0.2, 0.7, v) * (1 - band) : 0;
  if (band <= 0 && behind <= 0) return { gust: 0, wake: 0 };
  const k = time * WIND.drift;
  const k0 = Math.floor(k);
  const kf = smoothstep(0, 1, k - k0);
  const a = valueNoise(x, y, WIND.patchScale, 1 + k0);
  const b = valueNoise(x, y, WIND.patchScale, 2 + k0);
  const patch = smoothstep(0.35, 0.65, a + (b - a) * kf);
  return { gust: band * patch, wake: behind * patch };
}

/** How strong the wind is at a world cell, 0 (still) to 1 (a gust's crest). */
export const windGust = (
  x: number,
  y: number,
  time: number,
  dir: WindDir = DEFAULT_WIND_DIR,
): number => windFront(x, y, time, dir).gust;

/** A gust this strong bends grass over, and this strong flattens it. */
export const GUST_STEPS = [0.3, 0.8] as const;
/** A gust this strong (or a wake this strong) stirs the grass: it lightens without bending. */
export const STIR = { gust: 0.15, wake: 0.5 } as const;
/** How far each wind level (`windLevel`) lightens a lit cell's ink toward white, 0–1. */
export const WIND_LIGHT = [0, 0.1, 0.2, 0.32] as const;

/**
 * The wind level a grass or crop cell shows, 0–3 (`gust` and `wake` already scaled by the wind):
 * still, stirring (or settling in the wake), leaning, flat. The glyph pass lightens by level, so
 * a gust shades in and trails off as a wave rather than switching on.
 */
export function windLevel(gust: number, wake = 0): number {
  if (gust >= GUST_STEPS[1]) return 3;
  if (gust >= GUST_STEPS[0]) return 2;
  return gust >= STIR.gust || wake >= STIR.wake ? 1 : 0;
}

/** Grass glyphs by role (theme.ts `grassGlyphs`). */
export const GrassGlyph = { leanRight: 3, leanLeft: 4, flat: 5, upright: 6, sparse: 7 } as const;

/**
 * Grass at rest is tufted, not striped: a soft noise (`lushScale` cells across) picks dense `"`,
 * `'`, `,`, or a sparse `.`, jittered by a hash per cell, so lawns look grown. The same noise
 * tints it: a patch below `dryBelow` is straw and above `shadeAbove` deep green; `speck` of the
 * cells below `speckBelow` are straw on their own.
 */
export const GRASS = {
  lushScale: 7,
  lushSeed: 3,
  dense: 0.6,
  medium: 0.42,
  thin: 0.25,
  dryBelow: 0.28,
  shadeAbove: 0.72,
  speckBelow: 0.45,
  speck: 0.04,
  /** How far a hash jitters the noise, in noise units. */
  jitter: 0.5,
  /** A wind blowing more along the columns than this leans blades upright (`|`), not aslant. */
  uprightBelow: 0.4,
} as const;

/** Broad bare-earth patches between ground cover, stable in world cells. */
export const PLANTING = { scale: 9, seed: 17, bareBelow: 0.54, bareGlyph: 8 } as const;
export function plantingCell(x: number, y: number, gust: number, dir: WindDir = DEFAULT_WIND_DIR) {
  return valueNoise(x, y, PLANTING.scale, PLANTING.seed) < PLANTING.bareBelow
    ? { variant: PLANTING.bareGlyph, tone: Tone.none }
    : grassCell(x, y, gust, dir);
}

/** A grass cell's glyph and tone: the tufts at rest, leaning downwind in a gust, then flat. */
export function grassCell(
  x: number,
  y: number,
  gust: number,
  dir: WindDir = DEFAULT_WIND_DIR,
): { variant: number; tone: number } {
  const lush = valueNoise(x, y, GRASS.lushScale, GRASS.lushSeed);
  const h = cellHash(x, y);
  const tone =
    lush < GRASS.dryBelow || (lush < GRASS.speckBelow && ((h >>> 16) & 255) < GRASS.speck * 256)
      ? Tone.dry
      : lush > GRASS.shadeAbove
        ? Tone.shade
        : Tone.none;
  if (gust >= GUST_STEPS[1]) return { variant: GrassGlyph.flat, tone };
  if (gust >= GUST_STEPS[0]) {
    const lean =
      Math.abs(dir[0]) < GRASS.uprightBelow
        ? GrassGlyph.upright
        : dir[0] > 0
          ? GrassGlyph.leanRight
          : GrassGlyph.leanLeft;
    return { variant: lean, tone };
  }
  const score = lush + (((h >>> 8) & 255) / 256 - 0.5) * GRASS.jitter;
  const variant =
    score > GRASS.dense ? 0 : score > GRASS.medium ? 1 : score > GRASS.thin ? 2 : GrassGlyph.sparse;
  return { variant, tone };
}

/**
 * A grass cell's glyph: the tufts at rest; in a gust, leaning downwind, then flat. `wind` scales
 * the gusts (0 with reduced motion), which blow along `dir`.
 */
export function grassVariant(
  x: number,
  y: number,
  time: number,
  wind = 1,
  dir: WindDir = DEFAULT_WIND_DIR,
): number {
  return grassCell(x, y, wind * windGust(x, y, time, dir), dir).variant;
}

/** Crop glyphs by role (theme.ts `farmland`): rows at rest, then leaning right, left, and flat. */
export const CropGlyph = { leanRight: 2, leanLeft: 3, flat: 4 } as const;

/** Broad patches of a field ripen: above `ripeAbove` its noise (`ripeScale` cells) is straw. */
export const CROP = { ripeScale: 16, ripeSeed: 13, ripeAbove: 0.62 } as const;

/** A field cell's tone: `Tone.dry` where its patch has ripened. */
export const cropTone = (x: number, y: number): number =>
  valueNoise(x, y, CROP.ripeScale, CROP.ripeSeed) > CROP.ripeAbove ? Tone.dry : Tone.none;

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

/** The wind in a tree's crown at a world cell: the grass's front, `lag` seconds late. */
export const treeFront = (
  x: number,
  y: number,
  time: number,
  dir: WindDir = DEFAULT_WIND_DIR,
): { gust: number; wake: number } => windFront(x, y, time - TREE_WIND.lag, dir);

/** How strong the wind is in a tree's crown at a world cell, 0–1. */
export const treeGust = (
  x: number,
  y: number,
  time: number,
  dir: WindDir = DEFAULT_WIND_DIR,
): number => treeFront(x, y, time, dir).gust;

/**
 * How a crown's branches swing (cells; the cell shader moves each vertex of a crown): downwind
 * by `bend` × its reach from the trunk (so the tips swing most), at most `max`, and a flutter
 * of `flutter` across the wind at `rate` radians per second, each vertex at its own phase. In
 * the wake behind a gust the branches spring back: upwind of rest by up to `recoil` of the
 * swing, rocking at `bounce` radians per second as they settle.
 */
export const SWAY = {
  bend: 0.3,
  max: 3,
  flutter: 0.5,
  rate: 7,
  recoil: 0.45,
  bounce: 4,
} as const;

/**
 * How far (cells, [x, y]) a crown vertex `reach` cells from its trunk swings in a gust (`gust`
 * and `wake`, already scaled by the wind) at `time`: the CPU twin of the cell shader's sway.
 */
export function swayOffset(
  reach: number,
  gust: number,
  wake: number,
  time: number,
  phase: number,
  dir: WindDir = DEFAULT_WIND_DIR,
): [number, number] {
  const [dx, dy] = dir;
  const lean = gust - SWAY.recoil * wake * (0.6 + 0.4 * Math.cos(time * SWAY.bounce + phase));
  const along = lean * Math.min(SWAY.bend * reach, SWAY.max);
  const across =
    (gust + 0.6 * wake) *
    SWAY.flutter *
    Math.min(reach / 2, 1) *
    Math.sin(time * SWAY.rate + phase);
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

/** Where the sun is when there is none (night): to the northwest, a unit vector (x east, y south). */
export const DEFAULT_SUN: WindDir = [-Math.SQRT1_2, -Math.SQRT1_2];

/** Crown glyphs by role (theme.ts `tree_crown`): the rim's leaf, a thick interior, a dense core. */
export const CrownGlyph = { rim: 0, interior: 1, core: 4 } as const;
/**
 * Individual crowns (flat views): a cell with a non-crown neighbor is the rim (`%`); inside, a
 * dense `@` where value noise (`scale`, `seed`) is over `above`, except one cell in `skip`, and
 * `&` elsewhere. One crown in `dryEvery` is yellowing (`Tone.dry`).
 */
export const CROWN = {
  core: { scale: 3, seed: 17, above: 0.62, skip: 3 },
  dryEvery: 12,
} as const;

/**
 * A crown lit as a rounded canopy (shaders/glyph.ts): its surface normal leans outward by `tilt`
 * with at least `minZ` up, and the light is `base + gain · (normal · sun)`, within [min, max].
 */
export const CROWN_LIGHT = { tilt: 1.2, minZ: 0.08, base: 0.55, gain: 0.7, min: 0.38, max: 1.25 };

/** `CROWN_LIGHT` at crown-local (`x`, `y`) in -1–1, toward `sun`: the glyph shader's lighting. */
export function crownLight(x: number, y: number, [sx, sy, sz]: readonly number[]): number {
  const { tilt, minZ, base, gain, min, max } = CROWN_LIGHT;
  const z = Math.sqrt(Math.max(minZ, 1 - x * x - y * y));
  const norm = Math.hypot(x * tilt, y * tilt, z);
  const light = Math.hypot(sx!, sy!, sz!) || 1;
  const dot = (x * tilt * sx! + y * tilt * sy! + z * sz!) / norm / light;
  return Math.max(min, Math.min(max, base + gain * dot));
}

/**
 * A crown cell's glyph (theme.ts `tree_crown`): at rest the rim (`rim`: some neighbor isn't
 * crown) is `%` and the inside `&` or a dense `@` by hash; in a gust (`gust`, already scaled by
 * the wind), the leaves flutter, flipping between `%` and `&`.
 */
export function foliageVariant(x: number, y: number, time = 0, gust = 0, rim = true): number {
  const h = cellHash(x, y);
  if (gust >= TREE_WIND.step) return flutters(h, gust, time) ? 0 : 1;
  if (rim) return CrownGlyph.rim;
  const { scale, seed, above, skip } = CROWN.core;
  return valueNoise(x, y, scale, seed) > above && h % skip !== 0
    ? CrownGlyph.core
    : CrownGlyph.interior;
}

/** Whether the crown of feature `id` is yellowing: one in `CROWN.dryEvery`. */
export const crownIsDry = (id: number): boolean => cellHash(id, 5) % CROWN.dryEvery === 0;

/**
 * Woods as clumped crowns (SPEC.md §4): a crown per `cols × rows` block of cells, centered on a
 * hashed cell of the block. A cell farther than `clearing` (in blocks) from every center is a
 * clearing with chance `gaps`. In a gust the whole pattern leans downwind by `sway` cells at a
 * gust's crest, continuously, so crowns creep across cells. Foliage more than `lit` cells from
 * its crown's center toward the sun is lit, and away from it shaded.
 */
export const CANOPY = {
  cols: 4,
  rows: 2,
  clearing: 0.65,
  gaps: 0.5,
  sway: 1.5,
  lit: 0.75,
} as const;
/** Canopy glyphs by role (theme.ts `trees`); `rustle` is the foliage's other glyph in a gust. */
export const CanopyGlyph = { foliage: 3, gap: 4, palm: 5, needle: 6, rustle: 8 } as const;

/** How many cells the woods' pattern leans downwind in a gust (already scaled by the wind). */
export const canopyLean = (gust: number): number => CANOPY.sway * gust;

/** The woods' pattern at a world cell: a crown's center, foliage, or a clearing, and its tone. */
function canopyShape(
  x: number,
  y: number,
  variant: number,
  lean: WindDir,
  sun: WindDir,
): { variant: number; tone: number } {
  const { cols, rows } = CANOPY;
  // The pattern, read from upwind: fractional, so its edges creep a cell at a time.
  const px = x - lean[0];
  const py = y - lean[1];
  const gx = Math.floor(px / cols);
  const gy = Math.floor(py / rows);
  let best = Infinity;
  let bestHash = 0;
  let bx = 0;
  let by = 0;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const h = cellHash(gx + ox, gy + oy);
      const dx = px - ((gx + ox) * cols + (h % cols));
      const dy = py - ((gy + oy) * rows + ((h >>> 8) % rows));
      const d = (dx / cols) * (dx / cols) + (dy / rows) * (dy / rows);
      if (d < best) {
        best = d;
        bestHash = h;
        bx = dx;
        by = dy;
      }
    }
  }
  if (Math.abs(bx) < 0.5 && Math.abs(by) < 0.5) {
    if (variant === 1) return { variant: CanopyGlyph.palm, tone: Tone.none };
    if (variant === 2) {
      return { variant: CanopyGlyph.needle + ((bestHash >>> 16) & 1), tone: Tone.none };
    }
    return { variant: (bestHash >>> 16) % 3, tone: Tone.none };
  }
  const clearing = best > CANOPY.clearing * CANOPY.clearing;
  // Gaps are picked by the fixed world cell, so a clearing moving over the wood reveals or hides
  // them one by one instead of re-rolling them.
  if (clearing && ((cellHash(x, y) >>> 8) & 255) < CANOPY.gaps * 256) {
    return { variant: CanopyGlyph.gap, tone: Tone.none };
  }
  const toSun = bx * sun[0] + by * sun[1];
  const tone = toSun > CANOPY.lit ? Tone.light : toSun < -CANOPY.lit ? Tone.shade : Tone.none;
  return { variant: CanopyGlyph.foliage, tone };
}

/**
 * A canopy cell's glyph and tone: at a crown's center, by the wood's kind (`variant`, classes.ts
 * `TREE_KINDS` + 1), else one of three by the crown's hash; around it, foliage or a clearing.
 * In a gust (`gust`, already scaled by the wind) the crowns lean downwind with it (the pattern
 * is read from upwind) and their foliage flutters.
 */
export function canopyCell(
  x: number,
  y: number,
  variant = 0,
  gust = 0,
  time = 0,
  dir: WindDir = DEFAULT_WIND_DIR,
  sun: WindDir = DEFAULT_SUN,
): { variant: number; tone: number } {
  const lean = canopyLean(gust);
  const cell = canopyShape(x, y, variant, [dir[0] * lean, dir[1] * lean], sun);
  if (
    cell.variant === CanopyGlyph.foliage &&
    gust >= TREE_WIND.step &&
    flutters(cellHash(x, y), gust, time)
  ) {
    return { variant: CanopyGlyph.rustle, tone: cell.tone };
  }
  return cell;
}

export const canopyVariant = (
  x: number,
  y: number,
  variant = 0,
  gust = 0,
  time = 0,
  dir: WindDir = DEFAULT_WIND_DIR,
): number => canopyCell(x, y, variant, gust, time, dir).variant;

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
      // Without a wind given, water just ripples (its gust bands need the wind to be named).
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
    case 'seating':
      return 0;
    case 'variant':
      return Math.min(ctx.variant ?? 0, count - 1);
    case 'ramp':
      return rampVariant(ctx.height, count);
    case 'planting': {
      const gust = (ctx.wind ?? 1) * windGust(ctx.x, ctx.y, ctx.time, ctx.windDir);
      return Math.min(plantingCell(ctx.x, ctx.y, gust, ctx.windDir).variant, count - 1);
    }
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
      // The rim of a crown: some side neighbor is something else.
      const rim = (
        [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const
      ).some(([dx, dy]) => ctx.neighbor(dx, dy) !== cls);
      return Math.min(foliageVariant(ctx.x, ctx.y, ctx.time, gust, rim), count - 1);
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
  /** RG8, MAX_VARIANTS × MAX_CLASSES: low/high glyph bytes per (variant, class id). */
  table: Uint8Array;
  /** Kind code per class id (0 = not drawn). */
  kinds: Int32Array;
  /** Glyph count per class id. */
  counts: Int32Array;
  /** Bitmask of class ids each class id connects to (roads). */
  connects: Int32Array;
  /** Linear RGB per class id. */
  colors: Float32Array;
  /** Background pigments; default to each class's glyph color. */
  fillColors: Float32Array;
  /** Background fill strength per class id (theme.ts `ClassStyle.fill`, 0 = none). */
  fills: Float32Array;
};

/** Build the select shader's lookup tables from a theme and the glyph atlas's index. */
export function buildGlyphTables(theme: Theme, atlasIndex: (glyph: string) => number): GlyphTables {
  const glyphIndex = (glyph: string) => {
    const index = atlasIndex(glyph);
    if (index < 0 || index > MAX_GLYPHS)
      throw new Error(`map glyph ${glyph} has atlas index ${index}, outside 0–${MAX_GLYPHS}`);
    return index;
  };
  const table = new Uint8Array(MAX_VARIANTS * MAX_CLASSES * 2);
  const setGlyph = (entry: number, glyph: string) => {
    const index = glyphIndex(glyph);
    table[entry * 2] = index & 255;
    table[entry * 2 + 1] = index >> 8;
  };
  const kinds = new Int32Array(MAX_CLASSES);
  const counts = new Int32Array(MAX_CLASSES);
  const connectMasks = new Int32Array(MAX_CLASSES);
  const colors = new Float32Array(MAX_CLASSES * 3);
  const fillColors = new Float32Array(MAX_CLASSES * 3);
  const fills = new Float32Array(MAX_CLASSES);

  for (const cls of renderClasses) {
    const id = classId(cls);
    const style = theme.styles[cls];
    if (!style) continue;
    kinds[id] = kindCodes[style.kind];
    counts[id] = style.glyphs.length;
    for (let v = 0; v < MAX_VARIANTS; v++) {
      const glyph = style.glyphs[Math.min(v, style.glyphs.length - 1)]!;
      setGlyph(id * MAX_VARIANTS + v, glyph);
    }
    for (const other of connectsTo[cls] ?? []) connectMasks[id]! |= classBit(other);
    colors[id * 3] = ((style.color >> 16) & 0xff) / 255;
    colors[id * 3 + 1] = ((style.color >> 8) & 0xff) / 255;
    colors[id * 3 + 2] = (style.color & 0xff) / 255;
    const fillColor = style.fillColor ?? style.color;
    fillColors[id * 3] = ((fillColor >> 16) & 0xff) / 255;
    fillColors[id * 3 + 1] = ((fillColor >> 8) & 0xff) / 255;
    fillColors[id * 3 + 2] = (fillColor & 0xff) / 255;
    fills[id] = style.fill ?? 0;
  }
  ridgeGlyphs.forEach((glyph, i) => {
    setGlyph(ROOF_ROW * MAX_VARIANTS + RIDGE_VARIANT + i, glyph);
  });
  arrowGlyphs.forEach((glyph, i) => setGlyph(ROOF_ROW * MAX_VARIANTS + ARROW_VARIANT + i, glyph));
  for (let mask = 0; mask < 16; mask++) {
    setGlyph(WALL_SINGLE_ROW * MAX_VARIANTS + mask, wallGlyph('single', mask));
    setGlyph(WALL_DOUBLE_ROW * MAX_VARIANTS + mask, wallGlyph('double', mask));
  }
  sextantGlyphs.forEach((glyph, mask) => {
    setGlyph(SEXTANT_ROW * MAX_VARIANTS + mask, glyph);
  });
  return { table, kinds, counts, connects: connectMasks, colors, fillColors, fills };
}
