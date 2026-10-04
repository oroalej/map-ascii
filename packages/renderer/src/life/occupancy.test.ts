import { describe, expect, it } from 'vitest';
import {
  bodiesOverlap,
  bodyInside,
  bodyHitsPolygon,
  Occupancy,
  PolygonIndex,
  type Body,
  type Polygon,
} from './occupancy';

const box = (x: number, y: number, length = 4, width = 2): Body => ({
  x,
  y,
  length,
  width,
  hx: 1,
  hy: 0,
});
const ring = (x: number, y: number, w: number, h: number) => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
  { x, y },
];

describe('ground footprints', () => {
  it('finds the same first blocker with owner/ignore exclusions without changing occupancy', () => {
    const occupied = new Occupancy(),
      owner = {},
      ignored = {},
      blocker = {};
    occupied.set(owner, [box(0, 0)]);
    occupied.set(ignored, [box(1, 0)]);
    occupied.set(blocker, [box(2, 0)]);
    const before = occupied.conflicts(owner, [box(0, 0)], ignored);
    expect(occupied.firstConflict(owner, [box(0, 0)], ignored)).toBe(blocker);
    expect(occupied.conflicts(owner, [box(0, 0)], ignored)).toBe(before);
    occupied.delete(blocker);
    expect(occupied.firstConflict(owner, [box(0, 0)], ignored)).toBeUndefined();
    expect(occupied.firstConflict(owner, [box(0, 0)])).toBe(ignored);
  });
  it('matches exhaustive tests around a concave polygon with a hole', () => {
    const polygons: Polygon[] = [
      [
        [
          { x: -20, y: -20 },
          { x: 20, y: -20 },
          { x: 20, y: 0 },
          { x: 0, y: 0 },
          { x: 0, y: 20 },
          { x: -20, y: 20 },
          { x: -20, y: -20 },
        ],
        ring(-15, -15, 8, 8),
      ],
      [ring(40, 40, 6, 6)],
    ];
    const index = new PolygonIndex();
    polygons.forEach((p) => index.add(p));
    let seed = 123;
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    for (let i = 0; i < 2000; i++) {
      const heading = random() * Math.PI * 2;
      const body = {
        ...box(random() * 100 - 40, random() * 100 - 40, random() * 12, random() * 8),
        hx: Math.cos(heading),
        hy: Math.sin(heading),
      };
      expect(index.hits([body])).toBe(polygons.some((p) => bodyHitsPolygon(body, p)));
    }
  });
  it('retains near-touch tolerance and queries padded bounds across bins', () => {
    const polygon = [ring(1, 1, 10, 10)];
    const index = new PolygonIndex();
    index.add(polygon);
    const body = box(12 + 1e-7, 5, 2, 2);
    expect(bodyHitsPolygon(body, polygon)).toBe(true);
    expect(index.hits([body])).toBe(true);
    expect(index.near(11, 3, 12, 4)).toBe(true);
    expect(index.near(24, 3, 25, 4)).toBe(false);
    const seam = new PolygonIndex();
    seam.add([ring(12, 1, 1, 1)]);
    expect(seam.near(11.999, 1, 11.999, 2)).toBe(true);
  });
  it('checks rotated vehicles, including their ends rather than only centers', () => {
    expect(bodiesOverlap(box(0, 0), box(3, 0))).toBe(true);
    expect(bodiesOverlap(box(0, 0), box(0, 3))).toBe(false);
    expect(bodiesOverlap(box(0, 0), { ...box(2, 2), hx: Math.SQRT1_2, hy: Math.SQRT1_2 })).toBe(
      true,
    );
  });
  it('rejects a car whose center fits but whose body crosses the lot edge', () => {
    const lot = [ring(0, 0, 10, 10)];
    expect(bodyInside(box(5, 5), lot)).toBe(true);
    expect(bodyInside(box(1, 5), lot)).toBe(false);
  });
  it('rejects holes contained by a body, even when every corner is in the lot', () => {
    const lot = [ring(0, 0, 10, 10), ring(4.8, 4.8, 0.4, 0.4)];
    expect(bodyInside(box(5, 5), lot)).toBe(false);
    expect(bodyHitsPolygon(box(5, 5, 0.1, 0.1), lot)).toBe(false);
  });
  it('indexes moving bodies and removes their old reservation', () => {
    const occupied = new Occupancy(),
      me = {},
      other = {};
    occupied.set(other, [box(0, 0)]);
    expect(occupied.conflicts(me, [box(1, 0)])).toBeGreaterThan(0);
    expect(occupied.conflicts(other, [box(0, 0)])).toBe(0);
    occupied.set(other, [box(30, 30)]);
    expect(occupied.conflicts(me, [box(1, 0)])).toBe(0);
  });
  it('checks polygon boundaries across spatial bins without filling courtyards', () => {
    const terrain = new PolygonIndex();
    terrain.add([ring(-20, -20, 40, 40), ring(-5, -5, 10, 10)]);
    expect(terrain.hits([box(0, 0)])).toBe(false);
    expect(terrain.hits([box(12, 0)])).toBe(true);
    expect(terrain.hits([box(50, 0)])).toBe(false);
  });
});
