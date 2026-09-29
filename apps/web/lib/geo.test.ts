import type { SubdivisionArea } from '@atlas/shared';
import { describe, expect, it } from 'vitest';
import { areaAt, metersPerPixel, scaleBar } from './geo';

describe('scaleBar', () => {
  it('picks the longest 1/2/5 × 10ⁿ length that fits', () => {
    for (const zoom of [7, 10.3, 15, 17.6, 21]) {
      const bar = scaleBar(13.6, zoom, 120);
      expect(bar.pixels).toBeLessThanOrEqual(120);
      expect(bar.pixels).toBeGreaterThan(120 / 2.5);
      expect(String(bar.meters)).toMatch(/^[125]0*$|^0\.[0-9]*[125]$/);
    }
  });

  it('labels meters and kilometers', () => {
    expect(scaleBar(0, 17).label).toMatch(/ m$/);
    expect(scaleBar(0, 8).label).toMatch(/ km$/);
  });

  it('uses the renderer’s 512-px tiles', () => {
    expect(metersPerPixel(0, 0)).toBeCloseTo(40_075_016.686 / 512, 3);
  });
});

describe('areaAt', () => {
  const square = (w: number, s: number, e: number, n: number) => [
    [
      [w, s],
      [e, s],
      [e, n],
      [w, n],
      [w, s],
    ],
  ];
  const areas: SubdivisionArea[] = [
    {
      name: 'A',
      approximate: false,
      geometry: { type: 'Polygon', coordinates: square(0, 0, 1, 1) },
    },
    {
      name: 'B',
      approximate: true,
      geometry: { type: 'MultiPolygon', coordinates: [square(2, 0, 3, 1)] },
    },
  ];

  it('finds the containing area, polygons and multipolygons alike', () => {
    expect(areaAt(areas, 0.5, 0.5)?.name).toBe('A');
    expect(areaAt(areas, 2.5, 0.5)?.name).toBe('B');
    expect(areaAt(areas, 1.5, 0.5)).toBeUndefined();
  });
});
