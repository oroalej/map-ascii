import { expect, it } from 'vitest';
import { roofPlan, enrichRoofs } from './roofs';
import { isRoofPlan, roofFrame, type RoofPoint } from '@atlas/shared';
import type { AtlasFeature } from '../03-normalize';

const l: RoofPoint[] = [
  [0, 0],
  [10, 0],
  [10, 4],
  [4, 4],
  [4, 10],
  [0, 10],
  [0, 0],
];
const rectangle: RoofPoint[] = [
  [0, 0],
  [10, 0],
  [10, 5],
  [0, 5],
  [0, 0],
];
const building = (ring = l, extra: Partial<AtlasFeature['properties']> = {}): AtlasFeature => ({
  type: 'Feature',
  geometry: { type: 'Polygon', coordinates: [ring.map(roofFrame([0, 0]).toLngLat)] },
  properties: { id: 'osm:way/1', class: 'building', height: 6, roof_plan: 'stale', ...extra },
  tippecanoe: { layer: 'buildings', minzoom: 12, maxzoom: 16 },
});

it('uses the bounded analysis ring for noisy densified footprints without changing geometry', () => {
  const noisy: RoofPoint[] = [];
  for (let i = 0; i < l.length - 1; i++) {
    const a = l[i]!,
      b = l[i + 1]!,
      dx = b[0] - a[0],
      dy = b[1] - a[1],
      length = Math.hypot(dx, dy);
    for (let j = 0; j < 16; j++) {
      const wobble = j ? (j % 2 ? 0.1 : -0.1) : 0;
      noisy.push([
        a[0] + (dx * j) / 16 - (dy / length) * wobble,
        a[1] + (dy * j) / 16 + (dx / length) * wobble,
      ]);
    }
  }
  noisy.push(noisy[0]!);
  expect(roofPlan(noisy)).toEqual(roofPlan(l));
  expect(roofPlan([...noisy].reverse())).toEqual(roofPlan(l));
  const f = building(noisy),
    geometry = structuredClone(f.geometry);
  expect(enrichRoofs([f]).plans).toBe(1);
  expect(f.geometry).toEqual(geometry);
});

it('clears stale plans on skipped features and preserves flat/topology/shape fallbacks', () => {
  const eligible = building();
  const flat = building(l, { variant: 'flat' }),
    grounds = building(l, { height: 0 });
  const part = building(l, { class: 'building_part' }),
    timber = building(l, { class: 'building_woodwork' });
  const hole = building();
  if (hole.geometry.type === 'Polygon')
    hole.geometry.coordinates.push(rectangle.map(roofFrame([0, 0]).toLngLat));
  const multi = building();
  if (multi.geometry.type === 'Polygon')
    multi.geometry = { type: 'MultiPolygon', coordinates: [multi.geometry.coordinates] };
  const ordinary = building(rectangle);
  const stats = enrichRoofs([eligible, flat, grounds, part, timber, hole, multi, ordinary]);
  expect(stats).toMatchObject({
    buildings: 5,
    plans: 1,
    rejected: { flat: 1, topology: 2, shapeOrWings: 1 },
  });
  expect(isRoofPlan(JSON.parse(eligible.properties.roof_plan!))).toBe(true);
  for (const f of [flat, grounds, part, timber, hole, multi, ordinary])
    expect(f.properties.roof_plan).toBeUndefined();
});

it('allows small-city plans, and guards ratios only from 200 standing buildings', () => {
  const city = (n: number, plans: number) =>
    Array.from({ length: n }, (_, i) => building(i < plans ? l : rectangle));
  expect(enrichRoofs([]).plans).toBe(0);
  expect(enrichRoofs(city(8, 1)).plans).toBe(1);
  expect(enrichRoofs(city(199, 21)).plans).toBe(21);
  expect(enrichRoofs(city(200, 20)).plans).toBe(20);
  expect(() => enrichRoofs(city(200, 21))).toThrow('exceed 10%');
});

it('splits equal-arm L, T and cross footprints into bounded rectangular leaves', () => {
  for (const ring of [
    l,
    [
      [0, 0],
      [12, 0],
      [12, 4],
      [8, 4],
      [8, 12],
      [4, 12],
      [4, 4],
      [0, 4],
      [0, 0],
    ],
    [
      [4, 0],
      [8, 0],
      [8, 4],
      [12, 4],
      [12, 8],
      [8, 8],
      [8, 12],
      [4, 12],
      [4, 8],
      [0, 8],
      [0, 4],
      [4, 4],
      [4, 0],
    ],
  ] as RoofPoint[][]) {
    const plan = roofPlan(ring)!;
    expect(isRoofPlan(plan)).toBe(true);
    const leaves = plan.nodes.filter((n) => n.type === 'roof');
    expect(leaves.length).toBeGreaterThanOrEqual(2);
    expect(leaves.length).toBeLessThanOrEqual(4);
    const area =
      Math.abs(ring.slice(1).reduce((a, p, i) => a + ring[i]![0] * p[1] - ring[i]![1] * p[0], 0)) /
      2;
    expect(leaves.reduce((a, n) => a + n.halfLengthM * n.halfWidthM * 4, 0)).toBeCloseTo(area, 1);
  }
  expect(roofPlan(l)!.nodes.filter((n) => n.type === 'roof')).toHaveLength(2);
});
it('is stable under winding, cyclic vertex order, and a twenty-degree rotation', () => {
  const base = roofPlan(l)!;
  expect(roofPlan([...l].reverse())).toEqual(base);
  const open = l.slice(0, -1),
    shifted = [...open.slice(2), ...open.slice(0, 2)];
  expect(roofPlan([...shifted, shifted[0]!])).toEqual(base);
  const theta = (20 * Math.PI) / 180;
  const rotated = l.map(([x, y]): RoofPoint => [
    x * Math.cos(theta) - y * Math.sin(theta),
    x * Math.sin(theta) + y * Math.cos(theta),
  ]);
  expect(
    roofPlan(rotated)!
      .nodes.filter((n) => n.type === 'roof')
      .map((n) => [n.halfLengthM, n.halfWidthM])
      .sort(),
  ).toEqual(
    base.nodes
      .filter((n) => n.type === 'roof')
      .map((n) => [n.halfLengthM, n.halfWidthM])
      .sort(),
  );
});
it('rejects rectangles, near-rectangles, narrow wings and degenerate input', () => {
  for (const ring of [
    [],
    [
      [0, 0],
      [0, 0],
    ],
    [
      [0, 0],
      [10, 0],
      [10, 5],
      [0, 5],
      [0, 0],
    ],
    [
      [0, 0],
      [10, 0],
      [10, 5],
      [0.1, 5],
      [0, 4.9],
      [0, 0],
    ],
    l.map(([x, y]) => [x / 3, y / 3]),
  ] as RoofPoint[][])
    expect(roofPlan(ring)).toBeUndefined();
});
