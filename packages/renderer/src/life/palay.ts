/**
 * Where palay dries: strips on the road shoulder beside farmland (SPEC.md §4). Pure, and worked
 * out once per tile in the tile worker. The lattice subdivides the world's tiles exactly, so a
 * slot belongs to one tile at every zoom life tiles use, and the same road makes the same strip
 * whichever tile drew it, on every visit.
 */
import {
  DEFAULT_ROAD_WIDTH_M,
  metersPerUnit,
  TILE_EXTENT,
  utilitySeed,
  type TileAddress,
} from '@atlas/shared';
import type { TilePoint } from '../raster/geometry';
import { LifeLine, type LifeField } from './geometry';

/** x0, y0, x1, y1 (tile units, on the shoulder), side (-1 or 1), slot hash (0–1). */
export const DRYING_STRIDE = 6;

export const PALAY_STRIP = {
  /** Lattice cells across the world's width: z15 tiles / 20, about 60 m a side in the tropics. */
  lattice: 2 ** 15 * 20,
  minLength: 20,
  maxLength: 45,
  /** Width of the strip, meters. */
  width: 3,
  /** Gap between the carriageway's edge and the strip's centerline, meters. */
  shoulder: 1.5,
  /** How far beside the road's center a field must be, meters. */
  probe: 10,
  /** A road bending further than this off the strip's chord would put the strip in the lane. */
  maxBend: 3,
  maxPerTile: 24,
} as const;

export type DryingLines = {
  coords: ArrayLike<number>;
  starts: ArrayLike<number>;
  kinds: ArrayLike<number>;
  widths: ArrayLike<number>;
  lineIds: ArrayLike<number>;
};

type Field = { rings: readonly (readonly TilePoint[])[]; box: readonly number[] };
type Run = { key: string; line: number; points: TilePoint[]; length: number };

const distance = (a: TilePoint, b: TilePoint) => Math.hypot(b.x - a.x, b.y - a.y);

const pointAlong = (points: readonly TilePoint[], along: number): TilePoint => {
  let left = along;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!,
      b = points[i]!;
    const step = distance(a, b);
    if (left <= step && step > 0) {
      const t = left / step;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    left -= step;
  }
  return points.at(-1)!;
};

/** The piece of a run between two distances along it. */
const between = (points: readonly TilePoint[], from: number, to: number): TilePoint[] => {
  const out = [pointAlong(points, from)];
  let at = 0;
  for (let i = 1; i < points.length; i++) {
    at += distance(points[i - 1]!, points[i]!);
    if (at > from && at < to) out.push(points[i]!);
  }
  out.push(pointAlong(points, to));
  return out;
};

/** Even-odd over every ring, so a field's holes stay out. */
export const insideRings = (rings: readonly (readonly TilePoint[])[], p: TilePoint) => {
  let inside = false;
  for (const ring of rings)
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i]!,
        b = ring[j]!;
      if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x)
        inside = !inside;
    }
  return inside;
};

const fieldBox = (rings: readonly (readonly TilePoint[])[]) => {
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const { x, y } of rings[0] ?? []) {
    box[0] = Math.min(box[0]!, x);
    box[1] = Math.min(box[1]!, y);
    box[2] = Math.max(box[2]!, x);
    box[3] = Math.max(box[3]!, y);
  }
  return box;
};

const inField = (fields: readonly Field[], p: TilePoint) =>
  fields.some(
    ({ rings, box }) =>
      p.x >= box[0]! && p.x <= box[2]! && p.y >= box[1]! && p.y <= box[3]! && insideRings(rings, p),
  );

/** Each road's longest run through each lattice cell of this tile. */
function latticeRuns(tile: TileAddress, lines: DryingLines, cell: number): Map<string, Run> {
  const runs = new Map<string, Run>();
  const cellOf = (value: number, origin: number) =>
    Math.floor((origin * TILE_EXTENT + value) / cell);
  const perTile = Math.round(TILE_EXTENT / cell);
  const tileX = tile.x * perTile,
    tileY = tile.y * perTile;
  const keep = (line: number, cx: number, cy: number, points: TilePoint[]) => {
    if (points.length < 2) return;
    // A run in the tile's buffer belongs to the neighbor.
    if (cx < tileX || cy < tileY || cx >= tileX + perTile || cy >= tileY + perTile) return;
    let length = 0;
    for (let i = 1; i < points.length; i++) length += distance(points[i - 1]!, points[i]!);
    const key = `${cx}/${cy}/${lines.lineIds[line]}`;
    const known = runs.get(key);
    if (!known || length > known.length) runs.set(key, { key, line, points, length });
  };
  for (let line = 0; line < lines.kinds.length; line++) {
    const kind = lines.kinds[line];
    if (kind !== LifeLine.roadMid && kind !== LifeLine.roadMinor) continue;
    let current: TilePoint[] = [];
    let cx = NaN,
      cy = NaN;
    for (let v = lines.starts[line]!; v < lines.starts[line + 1]! - 1; v++) {
      const a = { x: lines.coords[v * 2]!, y: lines.coords[v * 2 + 1]! };
      const b = { x: lines.coords[v * 2 + 2]!, y: lines.coords[v * 2 + 3]! };
      // Every place this segment crosses a lattice line, in order along it.
      const stops = [0, 1];
      const crossings = (from: number, to: number, origin: number) => {
        const low = Math.min(from, to),
          high = Math.max(from, to);
        for (let k = Math.ceil((origin * TILE_EXTENT + low) / cell); ; k++) {
          const at = k * cell - origin * TILE_EXTENT;
          if (at >= high) break;
          if (at > low) stops.push((at - from) / (to - from));
        }
      };
      crossings(a.x, b.x, tile.x);
      crossings(a.y, b.y, tile.y);
      stops.sort((p, q) => p - q);
      for (let s = 1; s < stops.length; s++) {
        const from = stops[s - 1]!,
          to = stops[s]!;
        if (to <= from) continue;
        const mid = (from + to) / 2;
        const nx = cellOf(a.x + (b.x - a.x) * mid, tile.x);
        const ny = cellOf(a.y + (b.y - a.y) * mid, tile.y);
        if (nx !== cx || ny !== cy) {
          keep(line, cx, cy, current);
          current = [{ x: a.x + (b.x - a.x) * from, y: a.y + (b.y - a.y) * from }];
          cx = nx;
          cy = ny;
        }
        current.push({ x: a.x + (b.x - a.x) * to, y: a.y + (b.y - a.y) * to });
      }
    }
    keep(line, cx, cy, current);
  }
  return runs;
}

const segmentsCross = (a: TilePoint, b: TilePoint, c: TilePoint, d: TilePoint) => {
  const side = (p: TilePoint, q: TilePoint, r: TilePoint) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0;
};

/** Whether a straight strip runs across any road or path in the tile, a side road's end included. */
function crossesRoad(a: TilePoint, b: TilePoint, lines: DryingLines) {
  const minX = Math.min(a.x, b.x),
    maxX = Math.max(a.x, b.x),
    minY = Math.min(a.y, b.y),
    maxY = Math.max(a.y, b.y);
  for (let line = 0; line < lines.kinds.length; line++) {
    if (lines.kinds[line]! > LifeLine.path) continue;
    for (let v = lines.starts[line]!; v < lines.starts[line + 1]! - 1; v++) {
      const cx = lines.coords[v * 2]!,
        cy = lines.coords[v * 2 + 1]!,
        dx = lines.coords[v * 2 + 2]!,
        dy = lines.coords[v * 2 + 3]!;
      if (Math.max(cx, dx) < minX || Math.min(cx, dx) > maxX) continue;
      if (Math.max(cy, dy) < minY || Math.min(cy, dy) > maxY) continue;
      if (segmentsCross(a, b, { x: cx, y: cy }, { x: dx, y: dy })) return true;
    }
  }
  return false;
}

/** The tile's drying strips, lowest slot hash first, since those stay out longest. */
export function dryingStrips(
  tile: TileAddress,
  lines: DryingLines,
  fields: readonly Pick<LifeField, 'kind' | 'rings'>[],
): Float32Array {
  const farmland = fields
    .filter((field) => field.kind === 'farmland')
    .map(({ rings }) => ({ rings, box: fieldBox(rings) }));
  if (!farmland.length) return new Float32Array();
  const perMeter = 1 / metersPerUnit(tile);
  const cell = (TILE_EXTENT * 2 ** tile.z) / PALAY_STRIP.lattice;
  const slots = [...latticeRuns(tile, lines, cell).values()]
    .map((run) => ({ run, hash: utilitySeed(`palay:${run.key}`) / 0x100000000 }))
    .sort((a, b) => a.hash - b.hash || (a.run.key < b.run.key ? -1 : 1));
  const out: number[] = [];
  for (const { run, hash } of slots) {
    if (out.length >= PALAY_STRIP.maxPerTile * DRYING_STRIDE) break;
    if (run.length < PALAY_STRIP.minLength * perMeter) continue;
    const span =
      PALAY_STRIP.minLength +
      (PALAY_STRIP.maxLength - PALAY_STRIP.minLength) *
        (utilitySeed(`palay:length:${run.key}`) / 0x100000000);
    const length = Math.min(span * perMeter, run.length);
    const trim = (run.length - length) / 2;
    const piece = between(run.points, trim, trim + length);
    let a = piece[0]!,
      b = piece.at(-1)!;
    // The same road makes the same sides, whichever way it was digitized.
    if (a.x > b.x || (a.x === b.x && a.y > b.y)) [a, b] = [b, a];
    const chord = distance(a, b);
    if (chord === 0) continue;
    const ux = (b.x - a.x) / chord,
      uy = (b.y - a.y) / chord;
    const bend = Math.max(...piece.map((p) => Math.abs((p.x - a.x) * uy - (p.y - a.y) * ux)));
    if (bend > PALAY_STRIP.maxBend * perMeter) continue;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const fieldAt = (side: number) =>
      inField(farmland, {
        x: mid.x - uy * side * PALAY_STRIP.probe * perMeter,
        y: mid.y + ux * side * PALAY_STRIP.probe * perMeter,
      });
    const preferred = utilitySeed(`palay:side:${run.key}`) % 2 ? 1 : -1;
    const side = fieldAt(preferred) ? preferred : fieldAt(-preferred) ? -preferred : 0;
    if (!side) continue;
    const width = lines.widths[run.line] || DEFAULT_ROAD_WIDTH_M;
    const offset = (width / 2 + PALAY_STRIP.shoulder) * perMeter * side;
    const from = { x: a.x - uy * offset, y: a.y + ux * offset };
    const to = { x: b.x - uy * offset, y: b.y + ux * offset };
    if (crossesRoad(from, to, lines)) continue;
    out.push(from.x, from.y, to.x, to.y, side, hash);
  }
  return Float32Array.from(out);
}
