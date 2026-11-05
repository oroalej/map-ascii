import { describe, expect, it } from 'vitest';
import { metersPerUnit, TILE_EXTENT, type TileAddress } from '@atlas/shared';
import { LifeLine } from './geometry';
import { DRYING_STRIDE, dryingStrips, PALAY_STRIP, type DryingLines } from './palay';

const TILE: TileAddress = { z: 15, x: 27_900, y: 15_100 };
const perMeter = 1 / metersPerUnit(TILE);
type Pt = { x: number; y: number };
type Road = { points: readonly Pt[]; kind?: number; id?: number; width?: number };
const lines = (roads: readonly Road[]): DryingLines => {
  const coords: number[] = [],
    starts: number[] = [];
  for (const { points } of roads) {
    starts.push(coords.length / 2);
    for (const p of points) coords.push(p.x, p.y);
  }
  starts.push(coords.length / 2);
  return {
    coords,
    starts,
    kinds: roads.map((r) => r.kind ?? LifeLine.roadMinor),
    widths: roads.map((r) => r.width ?? 6),
    lineIds: roads.map((r, i) => r.id ?? i + 1),
  };
};
const rect = (x0: number, y0: number, x1: number, y1: number) => ({
  kind: 'farmland' as const,
  rings: [
    [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
      { x: x0, y: y0 },
    ],
  ],
});
const stripsOf = (strips: Float32Array) =>
  Array.from({ length: strips.length / DRYING_STRIDE }, (_, i) => {
    const [x0, y0, x1, y1, side, hash] = strips.slice(i * DRYING_STRIDE, (i + 1) * DRYING_STRIDE);
    return { x0: x0!, y0: y0!, x1: x1!, y1: y1!, side: side!, hash: hash! };
  });
const ROAD: Road = {
  points: [
    { x: 0, y: 2000 },
    { x: TILE_EXTENT, y: 2000 },
  ],
};
const SOUTH = rect(0, 2000, TILE_EXTENT, 3000);

describe('dryingStrips', () => {
  it('lays strips on the shoulder on the field side, 20-45 m long', () => {
    const strips = stripsOf(dryingStrips(TILE, lines([ROAD]), [SOUTH]));
    expect(strips.length).toBeGreaterThan(0);
    for (const s of strips) {
      expect(s.y0).toBeCloseTo(2000 + (3 + PALAY_STRIP.shoulder) * perMeter, 2);
      expect(s.y1).toBeCloseTo(s.y0, 2);
      expect(s.side).toBe(1);
      const meters = (s.x1 - s.x0) / perMeter;
      expect(meters).toBeGreaterThanOrEqual(PALAY_STRIP.minLength - 0.01);
      expect(meters).toBeLessThanOrEqual(PALAY_STRIP.maxLength + 0.01);
      expect(s.hash).toBeGreaterThanOrEqual(0);
      expect(s.hash).toBeLessThan(1);
    }
  });

  it('follows the field to the other side of the road', () => {
    const strips = stripsOf(dryingStrips(TILE, lines([ROAD]), [rect(0, 1000, TILE_EXTENT, 2000)]));
    expect(strips.length).toBeGreaterThan(0);
    for (const s of strips) {
      expect(s.side).toBe(-1);
      expect(s.y0).toBeLessThan(2000);
    }
  });

  it('makes nothing on a road with no field beside it, or a tile with no farmland', () => {
    const far = rect(0, 3000, TILE_EXTENT, 4000);
    expect(dryingStrips(TILE, lines([ROAD]), [far])).toHaveLength(0);
    expect(dryingStrips(TILE, lines([ROAD]), [])).toHaveLength(0);
    expect(dryingStrips(TILE, lines([ROAD]), [{ ...SOUTH, kind: 'grass' }])).toHaveLength(0);
  });

  it('keeps to minor and mid roads', () => {
    for (const kind of [LifeLine.roadMajor, LifeLine.path, LifeLine.river])
      expect(dryingStrips(TILE, lines([{ ...ROAD, kind }]), [SOUTH])).toHaveLength(0);
    expect(dryingStrips(TILE, lines([{ ...ROAD, kind: LifeLine.roadMid }]), [SOUTH]).length).toBe(
      dryingStrips(TILE, lines([ROAD]), [SOUTH]).length,
    );
  });

  it('caps a tile, keeping the slots that stay out longest', () => {
    const many = lines(
      Array.from({ length: 6 }, (_, i) => ({
        points: [
          { x: 0, y: 500 + i * 400 },
          { x: TILE_EXTENT, y: 500 + i * 400 },
        ],
        id: 100 + i,
      })),
    );
    const strips = stripsOf(dryingStrips(TILE, many, [rect(0, 0, TILE_EXTENT, TILE_EXTENT)]));
    expect(strips).toHaveLength(PALAY_STRIP.maxPerTile);
    expect(strips.map((s) => s.hash)).toEqual(strips.map((s) => s.hash).sort((a, b) => a - b));
  });

  it('gives the same strips on a tile re-request and for a road drawn the other way', () => {
    const once = dryingStrips(TILE, lines([ROAD]), [SOUTH]);
    expect(dryingStrips(TILE, lines([ROAD]), [SOUTH])).toEqual(once);
    const reversed = { points: [...ROAD.points].reverse() };
    expect(dryingStrips(TILE, lines([reversed]), [SOUTH])).toEqual(once);
  });

  it('agrees across a tile seam: each slot in one tile, on one world lattice', () => {
    const east = { ...TILE, x: TILE.x + 1 };
    // One straight road, with the buffer copy of it that each tile really gets.
    const road = (from: number, to: number): Road => ({
      points: [
        { x: from, y: 2000 },
        { x: to, y: 2000 },
      ],
      id: 7,
    });
    const westSide = rect(0, 2000, TILE_EXTENT + 80, 3000);
    const a = stripsOf(dryingStrips(TILE, lines([road(0, TILE_EXTENT + 80)]), [westSide]));
    const b = stripsOf(dryingStrips(east, lines([road(-80, 1000)]), [rect(-80, 2000, 1000, 3000)]));
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    // Nothing is drawn twice, or runs past the edge of the tile that owns it.
    for (const s of a) expect(Math.max(s.x0, s.x1)).toBeLessThanOrEqual(TILE_EXTENT);
    for (const s of b) expect(Math.min(s.x0, s.x1)).toBeGreaterThanOrEqual(0);
    expect(new Set([...a, ...b].map((s) => s.hash)).size).toBe(a.length + b.length);
    // The slots near the seam on either side are in step: spacing carries straight across it.
    const size = (TILE_EXTENT * 2 ** TILE.z) / PALAY_STRIP.lattice;
    const cellOf = (x: number) => Math.floor(x / size);
    for (const s of [...a, ...b]) expect(cellOf(s.x0)).toBe(cellOf(s.x1 - 1e-3));
    // A shorter copy of the road makes the same strip in every cell it fully crosses.
    const shorter = stripsOf(dryingStrips(TILE, lines([road(3000, TILE_EXTENT + 80)]), [westSide]));
    const whole = shorter.filter((s) => cellOf(s.x0) > cellOf(3000));
    expect(whole.length).toBeGreaterThan(0);
    for (const s of whole) expect(a.find((o) => o.hash === s.hash)?.x0).toBeCloseTo(s.x0, 2);
  });

  it('stops a strip running across a side road on its own side, not one on the far side', () => {
    const target = stripsOf(dryingStrips(TILE, lines([ROAD]), [SOUTH]))[0]!;
    const midX = (target.x0 + target.x1) / 2;
    const branch = (toY: number): Road => ({
      points: [
        { x: midX, y: 2000 },
        { x: midX, y: toY },
      ],
      id: 50,
    });
    const hashes = (road: Road) =>
      stripsOf(dryingStrips(TILE, lines([ROAD, road]), [SOUTH])).map((s) => s.hash);
    expect(hashes(branch(2600))).not.toContain(target.hash);
    expect(hashes(branch(1400))).toContain(target.hash);
  });

  it('skips a bend that would put the strip in the lane', () => {
    const size = (TILE_EXTENT * 2 ** TILE.z) / PALAY_STRIP.lattice;
    const start = Math.ceil(2000 / size) * size;
    const hairpin = {
      points: [
        { x: start + 1, y: 2000 },
        { x: start + size / 2, y: 2000 + 30 * perMeter },
        { x: start + size - 1, y: 2000 },
      ],
    };
    const field = rect(0, 1000, TILE_EXTENT, 3000);
    expect(dryingStrips(TILE, lines([hairpin]), [field])).toHaveLength(0);
  });
});
