import { describe, expect, it } from 'vitest';
import { bendAt, laneBend, LANE_BEND, taper, type LaneTerrain } from './lane-clearance';
import { bodyHitsPolygon, type Body } from './occupancy';

/** A box obstacle in metres, x along the road (y is metres right of its centre line). */
function boxTerrain(x0: number, x1: number, y0: number, y1: number): LaneTerrain {
  const polygon = [
    [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
      { x: x0, y: y0 },
    ],
  ];
  return {
    near: (a, b, c, d) => a <= x1 && c >= x0 && b <= y1 && d >= y0,
    hits: (body: Body) => bodyHitsPolygon(body, polygon),
  };
}

// A straight 60 m road along +x in tile units of 2 per metre; travel right is +y (y points down).
const perMeter = 2;
const road = { points: [0, 0, 60 * perMeter, 0], perMeter, base: 2, lo: -4, hi: 4 };
const car = { ...road, length: 4.4, width: 1.8 };

describe('lane bends', () => {
  it('leaves a clear lane alone', () => {
    expect(laneBend(car, boxTerrain(20, 30, 10, 12))).toBeUndefined();
  });

  it('bends early and gently around a curb in the lane, clear at every sample', () => {
    // A curb covering the right half of the road from 25 to 35 m.
    const terrain = boxTerrain(25, 35, 0.5, 4);
    const bend = laneBend(car, terrain)!;
    expect(bend).toBeDefined();
    const at = (s: number) => bendAt(bend, s);
    // Clear of the curb alongside it, with the body's half width.
    for (let s = 25 - car.length / 2; s <= 35 + car.length / 2; s += 0.5)
      expect(car.base + at(s) + car.width / 2).toBeLessThanOrEqual(0.5);
    // It starts moving over before the curb, and never steeper than a lane bend.
    expect(at(25 - car.length / 2 - 4)).toBeLessThan(-0.5);
    for (let i = 1; i < bend.length; i++)
      expect(Math.abs(bend[i]! - bend[i - 1]!)).toBeLessThanOrEqual(
        LANE_BEND.slope * LANE_BEND.sampleM + 1e-6,
      );
    // Back in its lane well past the curb.
    expect(at(55)).toBe(0);
  });

  it('stays within the road and keeps its lane where nothing clears', () => {
    const wall = boxTerrain(25, 35, -5, 5);
    expect(laneBend(car, wall)).toBeUndefined();
  });

  it('holds a bend across a short gap instead of weaving', () => {
    const need = new Float32Array(30);
    need[5] = -3;
    need[12] = -3;
    const profile = taper(need, 0.25);
    for (let i = 5; i <= 12; i++) expect(profile[i]).toBe(-3);
  });
});
