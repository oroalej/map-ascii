import { describe, expect, it } from 'vitest';
import { classId, Flags, variantCode } from '../classes';
import { LabelRank } from '../labels';
import {
  buildTileGeometry,
  classifyRings,
  createIdRegistry,
  EXTENT,
  metersPerUnit,
  packId,
  longestRun,
  roofRidge,
  tileToLngLat,
  wallShade,
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

  it('turns lines into segment pairs, plus a point per vertex so short segments still draw', () => {
    const { lines, points } = buildTileGeometry(
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
    expect(vertices(points).map(({ x, y, cls }) => [x, y, cls])).toEqual(
      [
        [0, 0],
        [10, 0],
        [10, 10],
      ].map(([x, y]) => [x, y, classId('road_major')]),
    );
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
    expect(vertices(fills)[0]).toMatchObject({ height: 15, flags: Flags.landmark | Flags.ridged });
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

  it('skips event pins, unknown classes, and place labels as cells', () => {
    const { fills, lines, points } = buildTileGeometry(
      {
        events: layer([feature(1, { id: 'event/1', class: 'monument' }, [[[2, 2]]])]),
        labels: layer([feature(1, { id: 'osm:node/6', class: 'place_label' }, [[[1, 1]]])]),
        water: layer([feature(3, { id: 'osm:way/7', class: 'mystery' }, [square(0, 0, 10)])]),
      },
      createIdRegistry(),
    );
    expect(fills.positions.length + lines.positions.length + points.positions.length).toBe(0);
  });

  it('keeps region-only features apart from the tile’s own', () => {
    const river = (id: string, region: boolean) =>
      feature(2, { id, class: 'water_river', ...(region && { region: true }) }, [
        [
          [0, 0],
          [10, 0],
        ],
      ]);
    const geometry = buildTileGeometry(
      { water: layer([river('osm:way/1', false), river('osm:way/2', true)]) },
      createIdRegistry(),
    );
    expect([...geometry.lines.ids]).toEqual([1, 1]);
    expect([...geometry.region.lines.ids]).toEqual([2, 2]);
    expect(geometry.region.fills.indices).toHaveLength(0);
  });

  it('draws admin boundaries as lines', () => {
    const { lines } = buildTileGeometry(
      {
        admin: layer([
          feature(2, { id: 'osm:relation/5', class: 'admin_city' }, [
            [
              [0, 0],
              [10, 0],
            ],
          ]),
        ]),
      },
      createIdRegistry(),
    );
    expect(vertices(lines).map((v) => v.cls)).toEqual([
      classId('admin_city'),
      classId('admin_city'),
    ]);
  });

  it('finds the longest nearly straight run of a line', () => {
    const run = longestRun([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: 1 }, // a slight bend: same run
      { x: 20, y: 5 }, // a turn: a new, shorter run
    ])!;
    expect(run.length).toBeCloseTo(Math.hypot(20, 1));
    expect(run.mid).toEqual({ x: 10, y: 0.5 });
    expect(run.angle).toBeCloseTo(0);
    expect(longestRun([{ x: 1, y: 1 }])).toBeNull();
  });

  it('labels named streets on their longest run, ranked by road class', () => {
    const tile = { z: 16, x: 55_247, y: 30_252 };
    const street = (id: string, cls: string, name?: string) =>
      feature(2, { id, class: cls, ...(name && { name }) }, [
        [
          [0, 100],
          [0, 900],
        ],
      ]);
    const { labels } = buildTileGeometry(
      {
        roads: layer([
          street('osm:way/1', 'road_major', 'Magsaysay Avenue'),
          street('osm:way/2', 'road_minor', 'Elias Angeles Street'),
          street('osm:way/3', 'road_minor'),
        ]),
      },
      createIdRegistry(),
      tile,
    );
    expect(labels.map(({ text, rank, band }) => ({ text, rank, band }))).toEqual([
      { text: 'Magsaysay Avenue', rank: LabelRank.roadMajor, band: { min: 14 } },
      { text: 'Elias Angeles Street', rank: LabelRank.street, band: { min: 15.5 } },
    ]);
    expect(labels[0]!.angle).toBeCloseTo(Math.PI / 2); // north–south, y down
  });

  it('labels places at their point, ranked and banded by what they name', () => {
    const tile = { z: 8, x: 215, y: 118 };
    const place = (id: string, props: Record<string, string | boolean>) =>
      feature(1, { id, class: 'place_label', ...props }, [[[2048, 2048]]]);
    const { labels } = buildTileGeometry(
      {
        labels: layer([
          place('osm:relation/1', { name: 'Camarines Sur', place: 'province' }),
          place('osm:node/2', { name: 'Naga', place: 'city' }),
          place('osm:node/3', { name: 'Abella', place: 'quarter', subdivision_label: true }),
          place('osm:node/4', { name: 'Some Sitio', place: 'hamlet' }),
          place('osm:node/5', { place: 'hamlet' }),
        ]),
      },
      createIdRegistry(),
      tile,
    );
    expect(labels.map(({ text, rank, band }) => ({ text, rank, band }))).toEqual([
      { text: 'Camarines Sur', rank: LabelRank.province, band: { min: 0, max: 9.5 } },
      { text: 'Naga', rank: LabelRank.city, band: { min: 0, max: 13 } },
      { text: 'Abella', rank: LabelRank.subdivision, band: { min: 10.5, max: 16 } },
      { text: 'Some Sitio', rank: LabelRank.place, band: { min: 13.5 } },
    ]);
    // The tile's center, in lng/lat.
    const [lng, lat] = tileToLngLat(tile, { x: 2048, y: 2048 });
    expect(labels[0]).toMatchObject({ lng, lat });
    expect(lng).toBeCloseTo(-180 + (215.5 / 256) * 360, 6);
    expect(lat).toBeGreaterThan(13);
    expect(lat).toBeLessThan(15);
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
    expect(registry.takeNew().map((f) => f.id)).toEqual(['osm:way/9', 'osm:way/10']);
    const b = buildTileGeometry({ roads: layer([road('osm:way/10')]) }, registry);
    expect(registry.takeNew()).toEqual([]);
    expect([...a.lines.ids]).toEqual([1, 1, 2, 2]);
    expect([...b.lines.ids]).toEqual([2, 2]);
  });

  it('collects labels for features with an anchor and a name', () => {
    const plaza = feature(
      3,
      {
        id: 'osm:way/11',
        class: 'park',
        name: 'Plaza',
        landmark: true,
        label_lng: 123.5,
        label_lat: 13.5,
      },
      [square(0, 0, 100)],
    );
    const statue = feature(
      1,
      { id: 'osm:node/12', class: 'monument', name: 'Statue', label_lng: 1, label_lat: 2 },
      [[[5, 5]]],
    );
    const unnamed = feature(1, { id: 'osm:node/13', class: 'monument' }, [[[6, 6]]]);
    const registry = createIdRegistry();
    const tile = (x: number) =>
      buildTileGeometry(
        { landuse: layer([plaza]), poi: layer([statue, unnamed]) },
        registry,
      ).labels.map((l) => ({ ...l, x }));
    const [a, b] = [tile(0), tile(1)];
    expect(a).toEqual([
      {
        id: 1,
        text: 'Plaza',
        rank: LabelRank.landmark,
        lng: 123.5,
        lat: 13.5,
        band: { min: 16 },
        x: 0,
      },
      { id: 2, text: 'Statue', rank: LabelRank.monument, lng: 1, lat: 2, band: { min: 18 }, x: 0 },
    ]);
    // The same feature in another tile carries the same id and anchor.
    expect(b.map(({ x: _x, ...l }) => l)).toEqual(a.map(({ x: _x, ...l }) => l));
  });

  it('adds roads as strips of their real width when it knows the tile', () => {
    const tile = { z: 16, x: 55_247, y: 30_252 }; // ~13.6° N
    const perUnit = metersPerUnit(tile);
    expect(perUnit).toBeGreaterThan(0.13);
    expect(perUnit).toBeLessThan(0.15);
    const road = feature(2, { id: 'osm:way/20', class: 'road_mid', width: 10 }, [
      [
        [100, 100],
        [300, 100],
      ],
    ]);
    const { fills, lines } = buildTileGeometry({ roads: layer([road]) }, createIdRegistry(), tile);
    expect(lines.positions.length / 2).toBe(2); // the 1-cell line is still there for low zoom
    const strip = vertices(fills);
    expect(strip).toHaveLength(4);
    expect(fills.indices.length).toBe(6);
    expect(strip.every((v) => v.flags === Flags.corridor && v.cls === classId('road_mid'))).toBe(
      true,
    );
    const ys = strip.map((v) => v.y!);
    const half = 10 / 2 / perUnit;
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(2 * half, -0.5);
    const xs = strip.map((v) => v.x!);
    expect(Math.min(...xs)).toBeCloseTo(100 - half, -0.5); // square cap past the end
  });

  it('adds no strips without a tile address or a width', () => {
    const road = feature(2, { id: 'osm:way/21', class: 'road_mid', width: 10 }, [
      [
        [0, 0],
        [9, 0],
      ],
    ]);
    const path = feature(2, { id: 'osm:way/22', class: 'path' }, [
      [
        [0, 0],
        [9, 0],
      ],
    ]);
    expect(buildTileGeometry({ roads: layer([road]) }, createIdRegistry()).fills.ids).toHaveLength(
      0,
    );
    const tile = { z: 16, x: 55_247, y: 30_252 };
    expect(
      buildTileGeometry({ roads: layer([path]) }, createIdRegistry(), tile).fills.ids,
    ).toHaveLength(0);
  });

  it('carries the variant byte for furniture and roofs', () => {
    expect(variantCode('furniture', 'fountain')).toBe(2);
    expect(variantCode('furniture', 'swing')).toBe(0);
    expect(variantCode('building', 'flat')).toBe(1);
    expect(variantCode('building', 'gabled')).toBe(2);
    expect(variantCode('park', 'flat')).toBe(0);
    const { points } = buildTileGeometry(
      {
        poi: layer([
          feature(1, { id: 'osm:node/23', class: 'furniture', variant: 'flagpole' }, [[[1, 1]]]),
        ]),
      },
      createIdRegistry(),
    );
    const meta = points.meta;
    expect(meta[3]).toBe(3);
  });

  it('extrudes buildings with a height: a wall quad per edge and a roof', () => {
    const building = feature(3, { id: 'osm:way/30', class: 'building', height: 9 }, [
      square(0, 0, 100),
    ]);
    const ground = feature(3, { id: 'osm:way/31', class: 'building_school' }, [square(200, 0, 50)]);
    const { extrusions } = buildTileGeometry(
      { buildings: layer([building, ground]) },
      createIdRegistry(),
    );
    const v = vertices(extrusions);
    // 4 edges × 4 wall vertices + 5 roof vertices (the closed ring); nothing for the ground.
    expect(v).toHaveLength(4 * 4 + 5);
    expect(extrusions.indices.length).toBe(4 * 6 + 2 * 3);
    expect(v.every((p) => (p.flags! & Flags.extruded) !== 0 && p.height === 9)).toBe(true);
    const tops = v.filter((p) => (p.flags! & Flags.top) !== 0);
    expect(tops).toHaveLength(4 * 2 + 5);
    expect(v.filter((p) => (p.flags! & Flags.roof) !== 0)).toHaveLength(5);
  });

  it('shades walls by how directly they face the light (from the south-east)', () => {
    expect(wallShade(0, 1)).toBeGreaterThan(wallShade(1, 0)); // south-facing brighter than east
    expect(wallShade(0, 1)).toBeGreaterThan(wallShade(0, -1)); // than north-facing
    expect(wallShade(0, -1)).toBeLessThan(40);
  });

  it('puts a pitched roof ridge along the footprint long axis, lit side positive', () => {
    const pts = (ring: [number, number][]) => ring.map(([x, y]) => ({ x, y }));
    // A 200 × 60 rectangle: the ridge runs east-west through y = 30.
    const wide = roofRidge(
      pts([
        [0, 0],
        [200, 0],
        [200, 60],
        [0, 60],
        [0, 0],
      ]),
    );
    expect(wide.angle).toBe(0);
    expect(wide.distance({ x: 100, y: 30 })).toBeCloseTo(0);
    // The light comes from the south (y grows southward), so the south slope is lit.
    expect(wide.distance({ x: 100, y: 60 })).toBeGreaterThan(0);
    expect(wide.distance({ x: 100, y: 0 })).toBeLessThan(0);
    // A tall rectangle: the ridge runs north-south (90°, byte ~128).
    const tall = roofRidge(
      pts([
        [0, 0],
        [60, 0],
        [60, 200],
        [0, 200],
        [0, 0],
      ]),
    );
    expect(tall.angle).toBe(128);
    expect(tall.distance({ x: 30, y: 100 })).toBeCloseTo(0);
  });

  it('gives buildings a ridge attribute and flag, but not flat roofs or grounds', () => {
    const gabled = feature(3, { id: 'osm:way/40', class: 'building', height: 6 }, [
      square(0, 0, 100),
    ]);
    const flat = feature(3, { id: 'osm:way/41', class: 'building', height: 6, variant: 'flat' }, [
      square(200, 0, 100),
    ]);
    const ground = feature(3, { id: 'osm:way/42', class: 'building_school' }, [
      square(400, 0, 100),
    ]);
    const { fills } = buildTileGeometry(
      { buildings: layer([gabled, flat, ground]) },
      createIdRegistry(),
    );
    const v = vertices(fills);
    const ridged = (i: number) => (v[i]!.flags! & Flags.ridged) !== 0;
    expect([0, 5, 10].map(ridged)).toEqual([true, false, false]);
    expect([...fills.ridge.slice(0, 5)].some((d) => d !== 0)).toBe(true);
    expect([...fills.ridge.slice(5)].every((d) => d === 0)).toBe(true);
  });
});
