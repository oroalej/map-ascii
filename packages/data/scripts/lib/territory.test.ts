import { describe, expect, it } from 'vitest';
import type { Feature, Geometry, Polygon } from 'geojson';
import {
  bboxPolygon,
  createTerritory,
  geometryOutsideVoid,
  inTerritory,
  removeVoid,
} from './territory';

const city: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [1, 1],
      [5, 1],
      [5, 5],
      [4, 5],
      [4, 3],
      [3, 3],
      [3, 5],
      [1, 5],
      [1, 1],
    ],
  ],
};
const territory = createTerritory([0, 0, 5, 5], city, [0, 0, 2, 2]);
const feature = (geometry: Geometry): Feature => ({
  type: 'Feature',
  id: 'way/10',
  properties: { name: 'A road' },
  geometry,
});

describe('territory subtraction', () => {
  it('admits a retained boundary triangle without using subtraction object identity', () => {
    const boundary: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [2, 0],
          [0, 2],
          [0, 0],
        ],
      ],
    };
    const t = createTerritory([0, 0, 2, 2], boundary, [0, 0, 0.1, 0.1]);
    const triangle: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [0.5, 1.50000000001],
          [0.51, 1.49000000001],
          [0.505, 1.485],
          [0.5, 1.50000000001],
        ],
      ],
    };
    expect(triangle.coordinates[0]!.every(([lng, lat]) => inTerritory(lng!, lat!, t))).toBe(true);
    expect(geometryOutsideVoid(triangle, t)).toBe(true);
    const retained = feature(triangle);
    expect(removeVoid(retained, t)).toBe(retained);
    const intrusion: Polygon = {
      ...triangle,
      coordinates: [triangle.coordinates[0]!.map(([lng, lat]) => [lng!, lat! + 0.00001])],
    };
    expect(geometryOutsideVoid(intrusion, t)).toBe(false);
  });
  it('handles enclosed voids, feature holes and mixed polygon components independently', () => {
    const retained = {
      ...bboxPolygon([0, 0, 5, 5]),
      coordinates: [
        bboxPolygon([0, 0, 5, 5]).coordinates[0]!,
        bboxPolygon([2, 2, 3, 3]).coordinates[0]!,
      ],
    };
    const t = createTerritory([0, 0, 5, 5], retained, [0, 0, 1, 1]);
    expect(geometryOutsideVoid(bboxPolygon([1, 1, 4, 4]), t)).toBe(false);
    const withHole: Polygon = {
      type: 'Polygon',
      coordinates: [
        bboxPolygon([1, 1, 4, 4]).coordinates[0]!,
        bboxPolygon([1.5, 1.5, 3.5, 3.5]).coordinates[0]!,
      ],
    };
    expect(geometryOutsideVoid(withHole, t)).toBe(true);
    expect(removeVoid(feature(withHole), t)!.geometry).toBe(withHole);
    const good = bboxPolygon([0.2, 0.2, 0.8, 0.8]),
      bad = bboxPolygon([2.2, 2.2, 2.8, 2.8]);
    const mixed = feature({
      type: 'MultiPolygon',
      coordinates: [good.coordinates, bad.coordinates],
    });
    expect(geometryOutsideVoid(mixed.geometry, t)).toBe(false);
    expect(removeVoid(mixed, t)!.geometry).toEqual(good);
    expect(removeVoid(feature(bad), t)).toBeUndefined();
    const beyond = feature(bboxPolygon([5, 2, 6, 3]));
    expect(removeVoid(beyond, t)).toBe(beyond);
    expect(geometryOutsideVoid(beyond.geometry, t)).toBe(true);
  });
  it('preserves downtown, closed city edges and exact feature identity', () => {
    for (const coordinates of [
      [0, 0.5],
      [2, 0.5],
      [5, 2],
      [3, 4],
      [1.5, 1.5],
    ]) {
      const f = feature({ type: 'Point', coordinates });
      expect(removeVoid(f, territory)).toBe(f);
      expect(inTerritory(coordinates[0]!, coordinates[1]!, territory)).toBe(true);
    }
    const road = feature({
      type: 'LineString',
      coordinates: [
        [2, 1],
        [4, 1],
      ],
    });
    expect(removeVoid(road, territory)).toBe(road);
    const downtown = feature(bboxPolygon([0.2, 0.2, 1.8, 1.8]));
    expect(removeVoid(downtown, territory)).toBe(downtown);
  });
  it('drops void points including void-only camera edges and retains beyond-rectangle portions', () => {
    for (const coordinates of [
      [0, 4],
      [3.5, 4],
      [3, 0],
    ])
      expect(removeVoid(feature({ type: 'Point', coordinates }), territory)).toBeUndefined();
    const outside = feature({ type: 'Point', coordinates: [6, 4] });
    expect(removeVoid(outside, territory)).toBe(outside);
    expect(inTerritory(6, 4, territory)).toBe(false);
  });
  it('splits repeated exits without reversing, joining across gaps or duplicating identity', () => {
    const road = {
      ...feature({
        type: 'LineString',
        coordinates: [
          [4.5, 4],
          [2, 4],
          [4.6, 4],
        ],
      }),
      tippecanoe: { layer: 'roads', minzoom: 6 },
    };
    const clipped = removeVoid(road, territory)!;
    expect(clipped.geometry).toEqual({
      type: 'MultiLineString',
      coordinates: [
        [
          [4.5, 4],
          [4, 4],
        ],
        [
          [3, 4],
          [2, 4],
          [3, 4],
        ],
        [
          [4, 4],
          [4.6, 4],
        ],
      ],
    });
    expect(clipped.id).toBe(road.id);
    expect(clipped.properties).toBe(road.properties);
    expect(clipped.tippecanoe).toBe(road.tippecanoe);
    expect(road.geometry.type).toBe('LineString');
  });
  it('joins wraparound closed-line fragments without crossing the removed gap', () => {
    const ring = feature({
      type: 'LineString',
      coordinates: [
        [1.5, 1.5],
        [1.5, 3],
        [0.5, 3],
        [0.5, 1.5],
        [1.5, 1.5],
      ],
    });
    const before = structuredClone(ring);
    const clipped = removeVoid(ring, territory)!;
    expect(clipped.geometry).toEqual({
      type: 'LineString',
      coordinates: [
        [0.5, 2],
        [0.5, 1.5],
        [1.5, 1.5],
        [1.5, 3],
        [1, 3],
      ],
    });
    expect(clipped.id).toBe(ring.id);
    expect(clipped.properties).toBe(ring.properties);
    expect(ring).toEqual(before);
  });
  it('keeps collinear boundaries but discards a point-only tangency', () => {
    expect(
      removeVoid(
        feature({
          type: 'LineString',
          coordinates: [
            [2.5, 0.5],
            [3, 1],
            [3.5, 0.5],
          ],
        }),
        territory,
      ),
    ).toBeUndefined();
    const edge = feature({
      type: 'LineString',
      coordinates: [
        [5, 2],
        [5, 4],
      ],
    });
    expect(removeVoid(edge, territory)).toBe(edge);
  });
  it('cuts straddling buildings and retains polygon holes', () => {
    const building = feature(bboxPolygon([2.5, 0.5, 3, 1.5]));
    const clipped = removeVoid(building, territory)!;
    expect(clipped.geometry).toEqual(bboxPolygon([2.5, 1, 3, 1.5]));
    const withHole = {
      ...bboxPolygon([1, 1, 5, 5]),
      coordinates: [
        ...bboxPolygon([1, 1, 5, 5]).coordinates,
        bboxPolygon([2.5, 2.5, 3.5, 3.5]).coordinates[0]!,
      ],
    };
    const t = createTerritory([0, 0, 5, 5], withHole, [0, 0, 2, 2]);
    expect(removeVoid(feature({ type: 'Point', coordinates: [3, 3] }), t)).toBeUndefined();
    expect(
      (removeVoid(feature(bboxPolygon([2, 2, 4, 4])), t)!.geometry as Polygon).coordinates,
    ).toHaveLength(2);
  });
  it('does not cut beyond the camera rectangle', () => {
    const result = removeVoid(
      feature({
        type: 'LineString',
        coordinates: [
          [6, 0.5],
          [2.5, 0.5],
        ],
      }),
      territory,
    )!;
    expect(result.geometry).toEqual({
      type: 'LineString',
      coordinates: [
        [6, 0.5],
        [5, 0.5],
      ],
    });
  });
  it('retains all geometry and legacy membership with a null void', () => {
    const t = createTerritory([0, 0, 5, 5], city);
    const f = feature({
      type: 'LineString',
      coordinates: [
        [0, 4],
        [6, 4],
      ],
    });
    expect(removeVoid(f, t)).toBe(f);
    expect(inTerritory(0, 4, t)).toBe(true);
    expect(inTerritory(6, 4, t)).toBe(false);
  });
});
