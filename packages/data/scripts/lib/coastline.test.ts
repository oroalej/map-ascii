import type { BBox } from '@atlas/shared';
import { describe, expect, it } from 'vitest';
import { clipLine, seaPolygons, stitch, type Position } from './coastline';

const bbox: BBox = [0, 0, 10, 10];

/** Shoelace area of a ring (absolute). */
const ringArea = (ring: Position[]) => {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[j]![0] - ring[i]![0]) * (ring[j]![1] + ring[i]![1]);
  }
  return Math.abs(sum / 2);
};
const seaArea = (sea: Position[][][]) =>
  sea.reduce((total, [outer, ...holes]) => {
    return total + ringArea(outer!) - holes.reduce((h, r) => h + ringArea(r), 0);
  }, 0);

/** Build ways and a node lookup from coordinate lists (one way per list). */
function ways(...lines: Position[][]) {
  const nodes = new Map<number, Position>();
  const ids = new Map<string, number>();
  const out = lines.map((line) =>
    line.map((p) => {
      const key = p.join(',');
      let id = ids.get(key);
      if (id === undefined) {
        id = ids.size + 1;
        ids.set(key, id);
        nodes.set(id, p);
      }
      return id;
    }),
  );
  return { ways: out, coords: (id: number) => nodes.get(id) };
}

describe('stitch', () => {
  it('joins ways by shared end nodes and detects closed rings', () => {
    expect(stitch([[1, 2], [2, 3], [3, 1], [5, 6], [4, 5]])).toEqual({
      closed: [[1, 2, 3, 1]],
      open: [[4, 5, 6]],
    });
  });
});

describe('clipLine', () => {
  it('keeps the parts inside the bbox, flagging edge crossings', () => {
    const pieces = clipLine(
      [
        [-5, 5],
        [5, 5],
        [5, 15],
      ],
      bbox,
    );
    expect(pieces).toEqual([
      {
        coords: [
          [0, 5],
          [5, 5],
          [5, 10],
        ],
        startsOnEdge: true,
        endsOnEdge: true,
      },
    ]);
  });
});

describe('seaPolygons', () => {
  it('makes the sea south of a coast running east (land on the left)', () => {
    const { ways: w, coords } = ways([
      [-1, 5],
      [11, 5],
    ]);
    const result = seaPolygons(w, coords, bbox);
    expect(result.ok).toBe(true);
    if (result.ok) expect(seaArea(result.sea)).toBeCloseTo(50);
  });

  it('cuts a peninsula out of the sea, across split ways', () => {
    const { ways: w, coords } = ways(
      [
        [7, -1],
        [7, 5],
        [3, 5],
      ],
      [
        [3, 5],
        [3, -1],
      ],
    );
    const result = seaPolygons(w, coords, bbox);
    expect(result.ok).toBe(true);
    if (result.ok) expect(seaArea(result.sea)).toBeCloseTo(80);
  });

  it('keeps islands as holes in an open sea', () => {
    const { ways: w, coords } = ways([
      [4, 4],
      [6, 4],
      [6, 6],
      [4, 6],
      [4, 4],
    ]);
    const result = seaPolygons(w, coords, bbox);
    expect(result.ok).toBe(true);
    if (result.ok) expect(seaArea(result.sea)).toBeCloseTo(96);
  });

  it('has no sea without a coastline', () => {
    expect(seaPolygons([], () => undefined, bbox)).toEqual({ ok: true, sea: [], coastlines: [] });
  });

  it('reports a coastline that ends inside the region', () => {
    const { ways: w, coords } = ways([
      [-1, 5],
      [5, 5],
    ]);
    const result = seaPolygons(w, coords, bbox);
    expect(result.ok).toBe(false);
    expect(result.coastlines).toHaveLength(1);
  });
});
