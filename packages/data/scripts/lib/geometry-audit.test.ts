import { describe, expect, it } from 'vitest';
import type { Polygon } from 'geojson';
import { geometryAudit } from './geometry-audit';

const box = (x: number, y: number, w: number, h: number): Polygon => ({
  type: 'Polygon',
  coordinates: [
    [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
      [x, y],
    ].map(([a, b]) => [a! / 111320, b! / 111320]),
  ],
});

describe('generic footprint audit', () => {
  it('rejects whole-footprint crossings and enclosing an obstacle, but permits touching', () => {
    const site = box(0, 0, 50, 50),
      audit = geometryAudit(site);
    expect(audit.contains(box(45, 10, 10, 10))).toBe(false);
    expect(audit.contains(box(10, 10, 10, 10))).toBe(true);
    expect(audit.overlaps(box(5, 5, 30, 30), box(10, 10, 2, 2))).toBe(true);
    expect(audit.overlaps(box(5, 5, 5, 5), box(10, 5, 5, 5))).toBe(false);
    expect(audit.overlaps(box(5, 5, 5, 5), box(30, 30, 5, 5))).toBe(false);
  });
  it('retains holes and concave boundaries even when every proposed vertex is inside', () => {
    const site = box(0, 0, 50, 50);
    site.coordinates.push(box(20, 20, 10, 10).coordinates[0]!);
    expect(geometryAudit(site).contains(box(10, 10, 30, 30))).toBe(false);
    const concave: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [50, 0],
          [50, 50],
          [30, 50],
          [30, 20],
          [20, 20],
          [20, 50],
          [0, 50],
          [0, 0],
        ].map(([x, y]) => [x! / 111320, y! / 111320]),
      ],
    };
    expect(geometryAudit(concave).contains(box(10, 30, 30, 10))).toBe(false);
  });
});
