import { describe, expect, it } from 'vitest';
import {
  bodiesOverlap,
  bodyInside,
  bodyHitsPolygon,
  Occupancy,
  PolygonIndex,
  type Body,
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
