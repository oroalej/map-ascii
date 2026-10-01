import { describe, expect, it } from 'vitest';
import { utilityRecordId, type BBox, type UtilityPole } from '@atlas/shared';
import type { AtlasFeature } from '../03-normalize';
import {
  canonicalUtilityLine,
  generateUtilities,
  utilityEligible,
  utilityProjection,
} from './utilities';

const bounds: BBox = [123.17, 13.6, 123.2, 13.64];
const projection = utilityProjection(bounds);
const road = (id: string, points: [number, number][], highway = 'primary'): AtlasFeature => ({
  type: 'Feature',
  tippecanoe: { layer: 'roads', minzoom: 6, maxzoom: 16 },
  properties: { id, class: 'road_major', highway, width: 8 },
  geometry: { type: 'LineString', coordinates: points.map(projection.unproject) },
});
const poles = (result: ReturnType<typeof generateUtilities>): UtilityPole[] =>
  result.records.flatMap((r) => (r.kind === 'pole' ? [r.pole] : []));

describe('baked utility network', () => {
  it('uses original highway tags, excludes regional roads and tertiary streets', () => {
    expect(
      utilityEligible(
        road(
          'r',
          [
            [0, 0],
            [300, 0],
          ],
          'secondary_link',
        ),
      ),
    ).toBe(true);
    expect(
      utilityEligible(
        road(
          'r',
          [
            [0, 0],
            [300, 0],
          ],
          'tertiary',
        ),
      ),
    ).toBe(false);
    const f = road('r', [
      [0, 0],
      [300, 0],
    ]);
    f.properties.region = true;
    expect(utilityEligible(f)).toBe(false);
  });

  it('is identical across input order, reversed ways and rotated closed rings', () => {
    const a = road('a', [
      [-300, 0],
      [0, 0],
      [300, 0],
    ]);
    const b = road('b', [
      [0, 0],
      [0, 300],
    ]);
    const original = generateUtilities([a, b], bounds);
    const reverse = structuredClone(a);
    if (reverse.geometry.type === 'LineString') reverse.geometry.coordinates.reverse();
    expect(generateUtilities([b, reverse], bounds)).toEqual(original);
    const ring = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
    ];
    expect(canonicalUtilityLine(ring)).toEqual(
      canonicalUtilityLine([
        [1, 1],
        [1, 0],
        [0, 0],
        [0, 1],
        [1, 1],
      ]),
    );
    expect(new Set(original.records.map(utilityRecordId)).size).toBe(original.records.length);
  });

  it('keeps 18–42m main spacing and only connects drops to their explicit parent', () => {
    const result = generateUtilities(
      [
        road('r', [
          [-900, 0],
          [900, 0],
        ]),
      ],
      bounds,
    );
    const main = poles(result)
      .filter((p) => !p.partner)
      .map((p) => projection.project(p.at)[0])
      .sort((a, b) => a - b);
    expect(main.length).toBeGreaterThan(40);
    for (let i = 1; i < main.length; i++)
      expect(main[i]! - main[i - 1]!).toBeGreaterThanOrEqual(18 - 1e-6);
    for (let i = 1; i < main.length; i++)
      expect(main[i]! - main[i - 1]!).toBeLessThanOrEqual(42 + 1e-6);
    for (const p of poles(result).filter((p) => p.partner)) {
      const spans = result.records.filter(
        (r) => r.kind === 'span' && [r.span.from.id, r.span.to.id].includes(p.id),
      );
      expect(spans).toHaveLength(1);
      expect(spans[0]).toMatchObject({ kind: 'span', span: { kind: 'crossing' } });
    }
  });

  it('reuses exact retained lamp coordinates and never assigns one lamp twice', () => {
    const roads = [
      road('r', [
        [-900, 0],
        [900, 0],
      ]),
    ];
    const baseline = poles(generateUtilities(roads, bounds)).filter((p) => !p.partner);
    const lamps = baseline.map((p, i) => ({
      key: `lamp-${i}`,
      road: 'r',
      at: projection.unproject([projection.project(p.at)[0], Math.sign(p.normal[1]) * 4.5]),
    }));
    const shared = poles(generateUtilities(roads, bounds, lamps)).filter((p) => p.sharedLamp);
    expect(shared.length).toBeGreaterThan(5);
    expect(new Set(shared.map((p) => p.sharedLamp)).size).toBe(shared.length);
    for (const p of shared) {
      expect(p.at).toEqual(lamps.find((l) => l.key === p.sharedLamp)!.at);
      expect(p.transformer).toBe(false);
    }
  });

  it('rejects solid footprints, preserves holes, and ignores elevated cover', () => {
    const r = road('r', [
      [-400, 0],
      [400, 0],
    ]);
    const ring = (n: number) =>
      [
        [-n, -n],
        [n, -n],
        [n, n],
        [-n, n],
        [-n, -n],
      ].map((p) => projection.unproject(p as [number, number]));
    const building: AtlasFeature = {
      type: 'Feature',
      tippecanoe: { layer: 'buildings', minzoom: 6, maxzoom: 16 },
      properties: { id: 'b', class: 'building', height: 10 },
      geometry: { type: 'Polygon', coordinates: [ring(500), ring(100)] },
    };
    const retained = poles(generateUtilities([r, building], bounds));
    expect(retained.length).toBeGreaterThan(0);
    expect(retained.every((p) => Math.abs(projection.project(p.at)[0]) < 100)).toBe(true);
    building.properties.detail_overhead = true;
    expect(generateUtilities([r, building], bounds).records).toEqual(
      generateUtilities([r], bounds).records,
    );
  });

  it('does not invent links between nearby disconnected roads', () => {
    const result = generateUtilities(
      [
        road('a', [
          [-400, 0],
          [0, 0],
        ]),
        road('b', [
          [10, 0],
          [400, 0],
        ]),
      ],
      bounds,
    );
    expect(result.stats.junctions).toBe(0);
  });

  it('rejects buffered waterways and the median side of parallel carriageways', () => {
    const r = road('r', [
      [-400, 0],
      [400, 0],
    ]);
    const baseline = poles(generateUtilities([r], bounds));
    const side = baseline.find((p) => !p.partner)!.normal[1];
    const parallel = road(
      'service',
      [
        [-500, side * 12],
        [500, side * 12],
      ],
      'service',
    );
    expect(generateUtilities([r, parallel], bounds).stats.rejected.median).toBeGreaterThan(0);
    const water = road('water', [
      [-500, side * 4.5],
      [500, side * 4.5],
    ]);
    water.properties = { id: 'water', class: 'water_stream', width: 4 };
    expect(generateUtilities([r, water], bounds).stats.rejected.blocked).toBeGreaterThan(0);
  });
});
