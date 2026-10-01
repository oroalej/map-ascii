import type { LandmarkPlan } from '@atlas/shared';
import { describe, expect, it } from 'vitest';
import { footprintAxis, partOutline, planParts, planCredits } from './plan';

const METERS = 111_320;

/** A 100 m (east–west) × 40 m building at the equator, as lng/lat. */
const building = {
  type: 'Feature' as const,
  properties: { id: 'osm:way/1', class: 'building', height: 10 },
  geometry: {
    type: 'Polygon' as const,
    coordinates: [
      [
        [0, 0],
        [100 / METERS, 0],
        [100 / METERS, 40 / METERS],
        [0, 40 / METERS],
        [0, 0],
      ],
    ],
  },
};
const statue = {
  type: 'Feature' as const,
  properties: { id: 'osm:node/2' },
  geometry: { type: 'Point' as const, coordinates: [1, 1] },
};

const plan = (over: Partial<LandmarkPlan>): LandmarkPlan => ({
  id: 'plan/test',
  osm_id: 'osm:way/1',
  title: 'Test',
  front: 'e',
  parts: [],
  status: 'draft',
  sources: [{ title: 'Reference' }],
  ...over,
});

/** A part's center in meters (the mean of its outline, without the closing point). */
const centerOf = (ring: number[][]): [number, number] => {
  const pts = ring.slice(0, -1);
  return [
    (pts.reduce((s, p) => s + p[0]!, 0) / pts.length) * METERS,
    (pts.reduce((s, p) => s + p[1]!, 0) / pts.length) * METERS,
  ];
};

describe('footprintAxis', () => {
  const ring: [number, number][] = [
    [0, 0],
    [100, 0],
    [100, 40],
    [0, 40],
    [0, 0],
  ];

  it('runs along the long side, pointing to the front', () => {
    const east = footprintAxis(ring, [1, 0]);
    expect(east.along[0]).toBeCloseTo(1);
    expect(east.front).toBeCloseTo(50);
    expect(east.back).toBeCloseTo(-50);
    const west = footprintAxis(ring, [-1, 0]);
    expect(west.along[0]).toBeCloseTo(-1);
  });

  it("measures the footprint's width at a point along the axis, left and right seen from the front", () => {
    const axis = footprintAxis(ring, [1, 0]);
    // Looking at the east front (facing west), the viewer's right is north.
    expect(axis.right[1]).toBeCloseTo(1);
    const [left, right] = axis.section(10)!;
    expect(right - left).toBeCloseTo(40);
  });
});

describe('partOutline', () => {
  it('draws circles, hexagons, and squares of the given size', () => {
    expect(partOutline({ shape: 'circle', size_m: 10 }, [0, 0], 0)).toHaveLength(17);
    expect(partOutline({ shape: 'hexagon', size_m: 10 }, [0, 0], 0)).toHaveLength(7);
    const square = partOutline({ shape: 'square', size_m: 10 }, [0, 0], 0);
    const xs = square.map(([x]) => x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(10);
  });
});

describe('planParts', () => {
  it('places area parts along the long axis, toward the front', () => {
    const { parts } = planParts(
      [building],
      [
        plan({
          parts: [
            {
              kind: 'belfry',
              shape: 'hexagon',
              size_m: 6,
              height_m: 20,
              at: { along: 0.9, across: 1 },
            },
            {
              kind: 'dome',
              shape: 'square',
              size_m: 10,
              height_m: 18,
              at: { along: -0.5, across: 0 },
            },
          ],
        }),
      ],
    );
    expect(parts).toHaveLength(2);
    const [belfry, dome] = parts.map((p) =>
      centerOf((p.geometry as { coordinates: number[][][] }).coordinates[0]!),
    );
    // Front is east: along 0.9 → 45 m east of the center (x = 95); across +1 → north edge.
    expect(belfry![0]).toBeCloseTo(95, 0);
    expect(belfry![1]).toBeCloseTo(40, 0);
    expect(dome![0]).toBeCloseTo(25, 0);
    expect(dome![1]).toBeCloseTo(20, 0);
    expect(parts[0]!.properties).toMatchObject({
      id: 'plan:test/1',
      class: 'building_part',
      height: 20,
      variant: 'belfry',
    });
    expect(parts[0]!.tippecanoe.layer).toBe('buildings');
  });

  it('places point parts by offset in meters', () => {
    const { parts } = planParts(
      [statue],
      [
        plan({
          osm_id: 'osm:node/2',
          front: undefined,
          parts: [{ kind: 'tier', shape: 'circle', size_m: 8, height_m: 1, offset_m: [0, 0] }],
        }),
      ],
    );
    const ring = (parts[0]!.geometry as { coordinates: number[][][] }).coordinates[0]!;
    const xs = ring.map(([x]) => x!);
    expect((Math.max(...xs) - Math.min(...xs)) * METERS * Math.cos(Math.PI / 180)).toBeCloseTo(
      8,
      0,
    );
  });

  it('fails loudly for a missing feature, or a part that does not match its feature', () => {
    expect(() => planParts([building], [plan({ osm_id: 'osm:way/9' })])).toThrow(/not in the OSM/);
    const onPoint = plan({
      osm_id: 'osm:node/2',
      parts: [
        { kind: 'dome', shape: 'circle', size_m: 5, height_m: 5, at: { along: 0, across: 0 } },
      ],
    });
    expect(() => planParts([statue], [onPoint])).toThrow(/needs an area/);
  });
});

it('rejects rooftop plans anchored to grounds and collects unique reference credits', () => {
  const roof = plan({
    parts: [
      { kind: 'dome', shape: 'circle', size_m: 5, height_m: 10, at: { along: 0, across: 0 } },
    ],
  });
  expect(() =>
    planParts([{ ...building, properties: { ...building.properties, height: 0 } }], [roof]),
  ).toThrow(/standing building/);
  expect(
    planCredits([
      roof,
      { ...roof, credit: 'Author, CC BY-SA 4.0' },
      { ...roof, credit: 'Author, CC BY-SA 4.0' },
    ]),
  ).toEqual(['Author, CC BY-SA 4.0']);
});
