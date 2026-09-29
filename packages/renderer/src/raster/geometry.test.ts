import { describe, expect, it } from 'vitest';
import { classId, Flags } from '../classes';
import {
  buildTileGeometry,
  classifyRings,
  createIdRegistry,
  EXTENT,
  packId,
  ringCentroid,
  unpackId,
  type TileFeatureLike,
  type TileLayerLike,
  type TilePoint,
} from './geometry';

const layer = (features: TileFeatureLike[], extent = EXTENT): TileLayerLike => ({
  extent,
  length: features.length,
  feature: (i) => features[i]!,
});

const feature = (
  type: TileFeatureLike['type'],
  properties: TileFeatureLike['properties'],
  rings: [number, number][][],
): TileFeatureLike => ({
  type,
  properties,
  loadGeometry: () => rings.map((r) => r.map(([x, y]) => ({ x, y }))),
});

// Vector tile winding: exterior rings clockwise in screen space (y down), holes the other way.
const square = (x: number, y: number, s: number): [number, number][] => [
  [x, y],
  [x + s, y],
  [x + s, y + s],
  [x, y + s],
  [x, y],
];
const reversed = (ring: [number, number][]) => [...ring].reverse();

/** Vertices of a geometry as { cls, x, y } for easy assertions. */
const vertices = (g: { positions: Int16Array; meta: Uint8Array }) =>
  Array.from({ length: g.positions.length / 2 }, (_, i) => ({
    x: g.positions[i * 2],
    y: g.positions[i * 2 + 1],
    cls: g.meta[i * 4],
    height: g.meta[i * 4 + 1],
    flags: g.meta[i * 4 + 2],
  }));

describe('classifyRings', () => {
  const pts = (ring: [number, number][]): TilePoint[] => ring.map(([x, y]) => ({ x, y }));

  it('groups holes with their outer ring and starts a polygon per outer ring', () => {
    const polygons = classifyRings([
      pts(square(0, 0, 100)),
      pts(reversed(square(10, 10, 20))),
      pts(square(200, 0, 50)),
    ]);
    expect(polygons.map((p) => p.length)).toEqual([2, 1]);
  });

  it('drops degenerate rings', () => {
    expect(
      classifyRings([
        pts([
          [0, 0],
          [5, 5],
          [0, 0],
        ]),
      ]),
    ).toEqual([]);
  });

  it('finds the area-weighted centroid', () => {
    expect(ringCentroid(pts(square(0, 0, 100)))).toEqual({ x: 50, y: 50 });
  });
});

describe('id packing', () => {
  it('round-trips 32-bit feature indices through RGBA bytes', () => {
    for (const i of [0, 1, 255, 256, 65_535, 1_234_567, 0xffffffff]) {
      expect(unpackId(packId(i))).toBe(i);
    }
    expect(packId(0x01020304)).toEqual([4, 3, 2, 1]);
  });
});

describe('buildTileGeometry', () => {
  it('triangulates polygons with holes', () => {
    const registry = createIdRegistry();
    const { fills } = buildTileGeometry(
      {
        landuse: layer([
          feature(3, { id: 'osm:way/1', class: 'park' }, [
            square(0, 0, 100),
            reversed(square(25, 25, 50)),
          ]),
        ]),
      },
      registry,
    );
    expect(fills.positions.length / 2).toBe(10);
    expect(fills.indices.length).toBe(8 * 3); // a square with a square hole: 8 triangles
    expect(vertices(fills).every((v) => v.cls === classId('park'))).toBe(true);
  });

  it('turns lines into segment pairs', () => {
    const { lines } = buildTileGeometry(
      {
        roads: layer([
          feature(2, { id: 'osm:way/2', class: 'road_major' }, [
            [
              [0, 0],
              [10, 0],
              [10, 10],
            ],
          ]),
        ]),
      },
      createIdRegistry(),
    );
    expect(vertices(lines).map(({ x, y }) => [x, y])).toEqual([
      [0, 0],
      [10, 0],
      [10, 0],
      [10, 10],
    ]);
  });

  it('adds building center points and markers for special buildings and landmarks', () => {
    const { fills, points } = buildTileGeometry(
      {
        buildings: layer([
          feature(3, { id: 'osm:way/3', class: 'building_religious', height: 15, landmark: true }, [
            square(0, 0, 100),
          ]),
        ]),
      },
      createIdRegistry(),
    );
    expect(vertices(fills)[0]).toMatchObject({ height: 15, flags: Flags.landmark });
    expect(vertices(points).map((v) => [v.cls, v.x, v.y])).toEqual([
      [classId('building_religious'), 50, 50],
      [classId('marker_religious'), 50, 50],
      [classId('marker_landmark'), 50, 50],
    ]);
  });

  it('turns POI points into markers', () => {
    const { points } = buildTileGeometry(
      { poi: layer([feature(1, { id: 'osm:node/4', class: 'building_school' }, [[[7, 8]]])]) },
      createIdRegistry(),
    );
    expect(vertices(points)).toEqual([
      { x: 7, y: 8, cls: classId('marker_school'), height: 0, flags: 0 },
    ]);
  });

  it('skips admin and label layers and unknown classes', () => {
    const { fills, lines, points } = buildTileGeometry(
      {
        admin: layer([
          feature(3, { id: 'osm:relation/5', class: 'admin_city' }, [square(0, 0, 10)]),
        ]),
        labels: layer([feature(1, { id: 'osm:node/6', class: 'place_label' }, [[[1, 1]]])]),
        water: layer([feature(3, { id: 'osm:way/7', class: 'mystery' }, [square(0, 0, 10)])]),
      },
      createIdRegistry(),
    );
    expect(fills.positions.length + lines.positions.length + points.positions.length).toBe(0);
  });

  it('rescales other extents to 4096', () => {
    const { points } = buildTileGeometry(
      {
        poi: layer(
          [feature(1, { id: 'osm:node/8', class: 'building_market' }, [[[256, 512]]])],
          512,
        ),
      },
      createIdRegistry(),
    );
    expect(vertices(points)[0]).toMatchObject({ x: 2048, y: 4096 });
  });

  it('gives each feature id one stable index across tiles', () => {
    const registry = createIdRegistry();
    const road = (id: string) =>
      feature(2, { id, class: 'road_minor' }, [
        [
          [0, 0],
          [1, 1],
        ],
      ]);
    const a = buildTileGeometry(
      { roads: layer([road('osm:way/9'), road('osm:way/10')]) },
      registry,
    );
    expect(registry.takeNew()).toEqual(['osm:way/9', 'osm:way/10']);
    const b = buildTileGeometry({ roads: layer([road('osm:way/10')]) }, registry);
    expect(registry.takeNew()).toEqual([]);
    expect([...a.lines.ids]).toEqual([1, 1, 2, 2]);
    expect([...b.lines.ids]).toEqual([2, 2]);
  });
});
