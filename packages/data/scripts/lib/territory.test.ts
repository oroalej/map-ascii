import { describe, expect, it } from 'vitest';
import type { Feature, Geometry, Polygon } from 'geojson';
import { bboxPolygon, createTerritory, inTerritory, removeVoid } from './territory';

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
          [4.5, 4],
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
          [4.5, 4],
        ],
      ],
    });
    expect(clipped.id).toBe(road.id);
    expect(clipped.properties).toBe(road.properties);
    expect(clipped.tippecanoe).toBe(road.tippecanoe);
    expect(road.geometry.type).toBe('LineString');
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
