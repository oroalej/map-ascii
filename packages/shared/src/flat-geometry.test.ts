import { expect, it } from 'vitest';
import { localMetricProjection, METERS_PER_DEGREE, pointInPolygon } from './flat-geometry';

it('round-trips local metric offsets and preserves explicitly selected legacy arithmetic', () => {
  const origin: [number, number] = [123, 13];
  const projection = localMetricProjection(origin);
  const at = projection.from([30, -20]);
  expect(projection.to(at)[0]).toBeCloseTo(30, 7);
  expect(projection.to(at)[1]).toBeCloseTo(-20, 7);
  expect(at[0]).toBe(origin[0] + 30 / (METERS_PER_DEGREE * Math.cos((origin[1] * Math.PI) / 180)));
  const legacy = localMetricProjection(origin, { east: 111320, north: 110540 });
  expect(legacy.to(at)).toEqual([
    (at[0] - origin[0]) * (111320 * Math.cos((origin[1] * Math.PI) / 180)),
    (at[1] - origin[1]) * 110540,
  ]);
});

it('handles holes, reversed rings, empty polygons and disjoint outer rings', () => {
  const outer: [number, number][] = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
    [0, 0],
  ];
  const hole: [number, number][] = [
    [2, 2],
    [8, 2],
    [8, 8],
    [2, 8],
    [2, 2],
  ];
  expect(pointInPolygon([1, 1], [outer, hole])).toBe(true);
  expect(pointInPolygon([5, 5], [outer, hole])).toBe(false);
  expect(pointInPolygon([1, 1], [outer.slice().reverse(), hole.slice().reverse()])).toBe(true);
  expect(pointInPolygon([1, 1], [])).toBe(false);
  expect(pointInPolygon([21, 1], [outer, outer.map(([x, y]) => [x + 20, y])])).toBe(true);
});
