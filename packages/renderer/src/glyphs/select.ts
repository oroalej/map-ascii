/**
 * Glyph selection rules (ARCHITECTURE.md §4). The select shader (`shaders/select.ts`) implements
 * the same formulas on the GPU; these CPU versions build its lookup tables and are unit-tested.
 */
import { classId, MAX_CLASSES, renderClasses, type RenderClass } from '../classes';
import type { GlyphKind, Theme } from '../theme';

/** Numeric kind codes shared with the select shader. 0 means "not drawn". */
export const kindCodes: Record<GlyphKind, number> = {
  road: 1,
  water: 2,
  building: 3,
  diagonal: 4,
  rows: 5,
  scatter: 6,
  single: 7,
};

/** Width of the glyph table: the most variants any class can have. */
export const MAX_VARIANTS = 32;

/** Connectivity bits, with north toward the top of the screen. */
export const Dir = { N: 1, E: 2, S: 4, W: 8 } as const;
/** Road variants past the 16 masks: an isolated diagonal step. */
export const RISING = 16; // ╱ (neighbor to the NE or SW)
export const FALLING = 17; // ╲ (neighbor to the NW or SE)

/** How fast each water cell flips between its glyphs, in flips per second. */
export const WATER_RATE = 0.5;

/** Road classes connect to each other; paths also connect to roads. */
const roadClasses: readonly RenderClass[] = ['road_major', 'road_mid', 'road_minor'];
const connectsTo: Partial<Record<RenderClass, readonly RenderClass[]>> = {
  road_major: roadClasses,
  road_mid: roadClasses,
  road_minor: roadClasses,
  path: [...roadClasses, 'path'],
};

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
export function waterVariant(x: number, y: number, time: number): number {
  const h = cellHash(x, y);
  const phase = ((h >>> 8) & 255) / 255;
  return (h + Math.floor(time * WATER_RATE + phase)) % 2;
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
  /** Seconds, for water. */
  time: number;
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
    case 'water':
      return waterVariant(ctx.x, ctx.y, ctx.time);
    case 'building':
      return buildingVariant(ctx.height);
    case 'diagonal':
    case 'rows':
    case 'scatter':
      return patternVariant(kind, ctx.x, ctx.y, count);
    case 'single':
      return 0;
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
};

/** Build the select shader's lookup tables from a theme and the glyph atlas's index. */
export function buildGlyphTables(theme: Theme, glyphIndex: (glyph: string) => number): GlyphTables {
  const table = new Uint8Array(MAX_VARIANTS * MAX_CLASSES);
  const kinds = new Int32Array(MAX_CLASSES);
  const counts = new Int32Array(MAX_CLASSES);
  const connectMasks = new Int32Array(MAX_CLASSES);
  const colors = new Float32Array(MAX_CLASSES * 3);

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
    for (const other of connectsTo[cls] ?? []) connectMasks[id]! |= 1 << classId(other);
    colors[id * 3] = ((style.color >> 16) & 0xff) / 255;
    colors[id * 3 + 1] = ((style.color >> 8) & 0xff) / 255;
    colors[id * 3 + 2] = (style.color & 0xff) / 255;
  }
  return { table, kinds, counts, connects: connectMasks, colors };
}
