import { describe, expect, it } from 'vitest';
import { classId, Flags, Marking, markingOf, variantCode } from '../classes';
import { lifeTransferables } from '../life/geometry';
import { LabelRank } from '../labels';
import { LifeLine, PLACE_CODES, PLACE_STRIDE } from '../life/geometry';
import { pointInside } from '../life/occupancy';
import { swayOffset } from '../glyphs/select';
import { WIND_PRESETS, WIND_VARIATION } from '../life/wind';
import {
  buildTileGeometry,
  classifyRings,
  createIdRegistry,
  CROWN_SIDES,
  crownRing,
  hashString,
  ringTriangles,
  EXTENT,
  lngLatToTile,
  metersPerUnit,
  packId,
  parkingStalls,
  STALL,
  pointsAlong,
  longestRun,
  roofRidge,
  streetLabel,
  tileToLngLat,
  ringCentroid,
  sidewalkLine,
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

describe('mapped sidewalk joins', () => {
  it('keeps straight and right-angle offsets on either side, including reversed ways', () => {
    const way = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
    ];
    expect(sidewalkLine(way, 5)).toEqual([
      { x: 0, y: -5 },
      { x: 105, y: -5 },
      { x: 105, y: 100 },
    ]);
    expect(sidewalkLine([...way].reverse(), -5)).toEqual(sidewalkLine(way, 5).reverse());
  });
  it('bevels acute bends and hairpins instead of spiking or returning to the centerline', () => {
    for (const last of [
      { x: 0, y: 0 },
      { x: 0, y: 10 },
      { x: 1, y: -1 },
    ]) {
      const way = [{ x: 0, y: 0 }, { x: 100, y: 0 }, last];
      for (const offset of [-5, 5]) {
        const result = sidewalkLine(way, offset);
        expect(result).toHaveLength(4);
        for (const p of result.slice(1, -1)) {
          const distance = Math.hypot(p.x - 100, p.y);
          expect(distance).toBeGreaterThanOrEqual(5 - 1e-8);
          expect(distance).toBeLessThanOrEqual(10);
          expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
        }
      }
    }
  });
  it('handles empty, single-point, and repeated-point ways without invalid coordinates', () => {
    expect(sidewalkLine([], 5)).toEqual([]);
    expect(
      sidewalkLine(
        [
          { x: 1, y: 2 },
          { x: 1, y: 2 },
        ],
        5,
      ),
    ).toEqual([{ x: 1, y: 2 }]);
    expect(
      sidewalkLine(
        [
          { x: 0, y: 0 },
          { x: 0, y: 0 },
          { x: 10, y: 0 },
        ],
        5,
      ),
    ).toEqual([
      { x: 0, y: -5 },
      { x: 10, y: -5 },
    ]);
  });
});

describe('classifyRings', () => {
  it('puts mapped sidewalk bands on the correct side of the way with unequal widths', () => {
    const tile = { z: 16, x: 55192, y: 30266 };
    const unit = metersPerUnit(tile);
    for (const [coords, axis, center, leftSign] of [
      [
        [
          [1000, 2000],
          [3000, 2000],
        ],
        'y',
        2000,
        -1,
      ],
      [
        [
          [2000, 3000],
          [2000, 1000],
        ],
        'x',
        2000,
        -1,
      ],
      [
        [
          [2000, 1000],
          [2000, 3000],
        ],
        'x',
        2000,
        1,
      ],
    ] as const) {
      const result = buildTileGeometry(
        {
          roads: layer([
            feature(
              2,
              {
                id: 'walk',
                class: 'road_mid',
                width: 10,
                sidewalk: 'left',
                sidewalk_left_width: 2,
                oneway: -1,
              },
              [[...coords].map((p) => [p[0], p[1]])],
            ),
          ]),
        },
        createIdRegistry(),
        tile,
      );
      const band = vertices(result.fills).filter((v) => v.cls === classId('path'));
      expect(band).toHaveLength(4);
      expect(band.every((v) => Math.sign(v[axis]! - center) === leftSign)).toBe(true);
      const distances = band.map((v) => Math.abs(v[axis]! - center) * unit);
      expect(Math.min(...distances)).toBeCloseTo(5, 0);
      expect(Math.max(...distances)).toBeCloseTo(7, 0);
      expect(band.every((v) => v.flags === (Flags.corridor | Flags.sidewalk))).toBe(true);
      expect(Array.from(result.life.oneway!)).toEqual([-1, 0]);
      expect(Array.from(result.life.kinds)).toEqual([LifeLine.roadMid, LifeLine.path]);
      const walkY = result.life.coords[axis === 'y' ? 5 : 4]!;
      expect((walkY - center) * unit).toBeCloseTo(leftSign * 6);
      expect(result.life.widths[1]).toBe(2);
      expect(lifeTransferables(result.life)).toContain(result.life.oneway!.buffer);
    }
    const both = buildTileGeometry(
      {
        roads: layer([
          feature(
            2,
            {
              id: 'both',
              class: 'road_mid',
              width: 10,
              sidewalk: 'both',
              sidewalk_left_width: 2,
              sidewalk_right_width: 3,
            },
            [
              [
                [1000, 2000],
                [3000, 2000],
              ],
            ],
          ),
        ]),
      },
      createIdRegistry(),
      tile,
    );
    const band = vertices(both.fills).filter((v) => v.cls === classId('path'));
    expect(band).toHaveLength(8);
    expect((Math.max(...band.map((v) => v.y!)) - 2000) * unit).toBeCloseTo(8, 0);
  });

  it('retains road and crossing access in coarse tiles and uses only mapped sidewalks', () => {
    const tile = { z: 14, x: 13798, y: 7566 };
    for (const source of ['mapped', 'derived']) {
      const result = buildTileGeometry(
        {
          roads: layer([
            feature(
              2,
              { id: 'road', class: 'road_mid', width: 10, sidewalk: 'both', sidewalk_src: source },
              [
                [
                  [1000, 2000],
                  [3000, 2000],
                ],
              ],
            ),
          ]),
          poi: layer([
            feature(
              1,
              {
                id: 'cross',
                class: 'furniture',
                variant: 'crossing',
                crossing_bearing: 90,
                crossing_width: 10,
              },
              [[[2000, 2000]]],
            ),
          ]),
        },
        createIdRegistry(),
        tile,
        16,
      );
      expect(result.fills.positions).toHaveLength(0);
      expect(result.life.areas?.map((a) => a.kind)).toEqual(['carriageway', 'crossing']);
      expect(Array.from(result.life.kinds)).toEqual(
        source === 'mapped'
          ? [LifeLine.roadMid, LifeLine.path, LifeLine.path, LifeLine.path]
          : [LifeLine.roadMid, LifeLine.path],
      );
      const crossing = result.life.areas!.find((a) => a.kind === 'crossing')!;
      const unit = metersPerUnit(tile);
      expect(pointInside({ x: 2000, y: 2000 + 4 / unit }, crossing.rings)).toBe(true);
      expect(pointInside({ x: 2000 + 2 / unit, y: 2000 }, crossing.rings)).toBe(false);
    }
  });

  it('draws exact marking quads without point glyphs and hides them in coarse tiles', () => {
    const tile = { z: 16, x: 55192, y: 30266 };
    for (const [variant, kind, length, width] of [
      ['stop_line', Marking.stop, 0.5, 5],
      ['oneway_arrow', Marking.arrow, 3, 3],
    ] as const) {
      const f = feature(
        1,
        {
          id: variant,
          class: 'furniture',
          variant,
          stop_bearing: 90,
          stop_width: 5,
          stop_road: 'road_mid',
          arrow_bearing: 90,
          arrow_width: 3,
          arrow_road: 'road_mid',
        },
        [[[2000, 2000]]],
      );
      const result = buildTileGeometry({ poi: layer([f]) }, createIdRegistry(), tile, 16);
      const vs = vertices(result.fills);
      expect(vs).toHaveLength(4);
      expect(result.points.positions).toHaveLength(0);
      expect(result.life.coords).toHaveLength(0);
      expect(markingOf(result.fills.meta[3]!).kind).toBe(kind);
      expect(
        (Math.max(...vs.map((v) => v.x!)) - Math.min(...vs.map((v) => v.x!))) * metersPerUnit(tile),
      ).toBeCloseTo(length, 0);
      expect(
        (Math.max(...vs.map((v) => v.y!)) - Math.min(...vs.map((v) => v.y!))) * metersPerUnit(tile),
      ).toBeCloseTo(width, 0);
      const coarse = buildTileGeometry(
        { poi: layer([f]) },
        createIdRegistry(),
        { ...tile, z: 14 },
        16,
      );
      expect(coarse.fills.positions).toHaveLength(0);
      expect(coarse.points.positions).toHaveLength(0);
    }
  });

  it('keeps a baked arrow at the same world position in neighboring tile buffers', () => {
    const west = { z: 16, x: 55192, y: 30266 },
      east = { ...west, x: west.x + 1 };
    const anchor = tileToLngLat(west, { x: 4100, y: 2000 });
    const centers = [west, east].map((tile) => {
      const p = lngLatToTile(tile, anchor[0], anchor[1]);
      const result = buildTileGeometry(
        {
          poi: layer([
            feature(
              1,
              {
                id: 'stable-arrow',
                class: 'furniture',
                variant: 'oneway_arrow',
                arrow_bearing: 90,
                arrow_width: 3,
                arrow_road: 'road_mid',
              },
              [[[p.x, p.y]]],
            ),
          ]),
        },
        createIdRegistry(),
        tile,
        16,
      );
      const vs = vertices(result.fills);
      expect(vs).toHaveLength(4);
      return tileToLngLat(tile, {
        x: vs.reduce((s, v) => s + v.x!, 0) / 4,
        y: vs.reduce((s, v) => s + v.y!, 0) / 4,
      });
    });
    expect(
      Math.hypot(
        (centers[0]![0] - centers[1]![0]) * 111320 * Math.cos((anchor[1] * Math.PI) / 180),
        (centers[0]![1] - centers[1]![1]) * 111320,
      ),
    ).toBeLessThan(0.1);
  });

  it('packs frontage kind bits on flat and ridged buildings and retains commerce in the buffer', () => {
    const result = buildTileGeometry(
      {
        buildings: layer([
          feature(
            3,
            { id: 'flat-shop', class: 'building', height: 5, variant: 'flat', frontage: 'retail' },
            [square(1000, 1000, 100)],
          ),
          feature(
            3,
            {
              id: 'pitched-shop',
              class: 'building',
              height: 5,
              variant: 'gabled',
              frontage: 'service',
            },
            [square(1300, 1000, 100)],
          ),
        ]),
        poi: layer([
          feature(1, { id: 'buffer-shop', class: 'furniture', variant: 'shop_food' }, [
            [[-10, 1000]],
          ]),
        ]),
      },
      createIdRegistry(),
      { z: 16, x: 55192, y: 30266 },
    );
    const flags = vertices(result.fills).map((v) => v.flags!);
    expect(flags).toContain(Flags.frontage | Flags.frontageLow);
    expect(flags).toContain(Flags.frontage | Flags.frontageHigh | Flags.ridged);
    expect(Array.from(result.life.commerce!)).toContain(-10);
    expect(result.life.shops.length).toBe(6);
  });
  it('keeps one owned shop light and the same commerce anchor across clipped tile copies', () => {
    const left = { z: 16, x: 55192, y: 30266 },
      right = { ...left, x: left.x + 1 };
    const [shop_lng, shop_lat] = tileToLngLat(left, { x: 4050, y: 1100 });
    const geometries = [left, right].map((tile, i) => {
      const lo = i ? -80 : 3900,
        hi = i ? 304 : 4176;
      return buildTileGeometry(
        {
          buildings: layer([
            feature(
              3,
              {
                id: 'seam-shop',
                class: 'building_station',
                height: 6,
                frontage: 'food',
                shop_lng,
                shop_lat,
                shop_radius_m: 30,
              },
              [
                [
                  [lo, 1000],
                  [hi, 1000],
                  [hi, 1200],
                  [lo, 1200],
                  [lo, 1000],
                ],
              ],
            ),
          ]),
        },
        createIdRegistry(),
        tile,
      );
    });
    expect(geometries.map((g) => g.life.shops.length)).toEqual([3, 0]);
    expect(geometries[0]!.life.commerce![0]! - geometries[1]!.life.commerce![0]!).toBeCloseTo(4096);
    expect(geometries[0]!.life.shops[2]! * metersPerUnit(left)).toBeCloseTo(30);
  });
  it('rasterizes crossing anchors as road quads and transfers buffered signals without point glyphs', () => {
    const tile = { z: 16, x: 55192, y: 30266 };
    const result = buildTileGeometry(
      {
        poi: layer([
          feature(
            1,
            {
              id: 'cross',
              class: 'furniture',
              variant: 'crossing',
              crossing_bearing: 90,
              crossing_width: 10,
              crossing_road: 'road_mid',
            },
            [[[2048, 2048]]],
          ),
          feature(
            1,
            {
              id: 'signal',
              class: 'furniture',
              variant: 'signals',
              signal_radius: 6,
              signal_a: 0,
              signal_b: 90,
              life_signal: 'mapped',
            },
            [[[-10, 2048]]],
          ),
        ]),
      },
      createIdRegistry(),
      tile,
    );
    expect(result.points.positions).toHaveLength(0);
    expect(
      vertices(result.fills).every(
        (v) => v.cls === classId('road_mid') && v.flags === (Flags.corridor | Flags.crossing),
      ),
    ).toBe(true);
    expect(result.fills.positions.length).toBeGreaterThan(0);
    expect(Array.from(result.life.signals!)).toEqual([-10, 2048, 6, 0, 90, 1]);
  });
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
    for (const [cls, marker] of [
      ['building_school', 'marker_school'],
      ['building_hospital', 'marker_hospital'],
    ] as const) {
      const { points } = buildTileGeometry(
        { poi: layer([feature(1, { id: 'osm:node/4', class: cls }, [[[7, 8]]])]) },
        createIdRegistry(),
      );
      expect(vertices(points)).toEqual([{ x: 7, y: 8, cls: classId(marker), height: 0, flags: 0 }]);
    }
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
    const street = (id: string, cls: string, name?: string, kind?: string) =>
      feature(2, { id, class: cls, ...(name && { name }), ...(kind && { kind }) }, [
        [
          [0, 100],
          [0, 900],
        ],
      ]);
    const { labels } = buildTileGeometry(
      {
        roads: layer([
          street('osm:way/1', 'road_major', 'Magsaysay Avenue', 'highway=primary'),
          street('osm:way/2', 'road_mid', 'Elias Angeles Street', 'highway=secondary'),
          street('osm:way/3', 'road_mid', 'Taal Avenue', 'highway=tertiary'),
          street('osm:way/4', 'road_minor', 'Jade Street', 'highway=residential'),
          street('osm:way/5', 'road_minor'),
        ]),
      },
      createIdRegistry(),
      tile,
    );
    expect(labels.map(({ text, rank, band }) => ({ text, rank, band }))).toEqual([
      { text: 'Magsaysay Avenue', rank: LabelRank.roadMajor, band: { min: 14 } },
      { text: 'Elias Angeles Street', rank: LabelRank.street, band: { min: 15.5 } },
      { text: 'Taal Avenue', rank: LabelRank.streetMinor, band: { min: 17.5 } },
      { text: 'Jade Street', rank: LabelRank.streetMinor, band: { min: 18 } },
    ]);
    expect(labels[0]!.angle).toBeCloseTo(Math.PI / 2); // north–south, y down
  });

  it('names only the key streets at the Street level', () => {
    const at = (cls: string, kind?: string) => streetLabel(cls, kind);
    expect(at('road_major')).toEqual({ rank: LabelRank.roadMajor, band: { min: 14 } });
    expect(at('road_mid', 'highway=secondary')?.band).toEqual({ min: 15.5 });
    expect(at('road_mid', 'highway=secondary_link')?.band).toEqual({ min: 15.5 });
    expect(at('road_mid', 'highway=tertiary')?.band).toEqual({ min: 17.5 });
    expect(at('road_mid')?.band).toEqual({ min: 17.5 }); // unknown kind: the cautious tier
    expect(at('road_mid', 'amenity=parking')?.band).toEqual({ min: 17.5 });
    expect(at('road_minor', 'highway=residential')?.band).toEqual({ min: 18 });
    expect(at('path', 'highway=footway')?.band).toEqual({ min: 18.5 });
    expect(at('building')).toBeUndefined();
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

  it('finds a place in a tile, the inverse of tileToLngLat', () => {
    const tile = { z: 16, x: 55_247, y: 30_252 };
    for (const p of [
      { x: 0, y: 0 },
      { x: 1234, y: 3210 },
      { x: -500, y: 4600 },
    ]) {
      const [lng, lat] = tileToLngLat(tile, p);
      const back = lngLatToTile(tile, lng, lat);
      expect(back.x).toBeCloseTo(p.x, 6);
      expect(back.y).toBeCloseTo(p.y, 6);
    }
  });

  it('leaves strips out of tiles too coarse to be drawn at Place level', () => {
    const road = () =>
      feature(2, { id: 'osm:way/23', class: 'road_mid', width: 10 }, [
        [
          [100, 100],
          [300, 100],
        ],
      ]);
    const strips = (z: number) =>
      buildTileGeometry(
        { roads: layer([road()]) },
        createIdRegistry(),
        { z, x: 55_247 >> (16 - z), y: 30_252 >> (16 - z) },
        16,
      ).fills.ids.length;
    expect(strips(16)).toBeGreaterThan(0);
    expect(strips(15)).toBeGreaterThan(0); // the parent stands in while a tile loads
    expect(strips(14)).toBe(0);
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

  it('extracts explicitly authored flag designs without guessing flags on other poles', () => {
    const { life } = buildTileGeometry(
      {
        poi: layer([
          feature(1, { id: 'osm:node/21', class: 'furniture', variant: 'flagpole', flag: 'PH' }, [
            [[100, 200]],
          ]),
          feature(1, { id: 'osm:node/22', class: 'furniture', variant: 'flagpole' }, [
            [[300, 400]],
          ]),
          feature(1, { id: 'osm:node/23', class: 'furniture', variant: 'flagpole', flag: 'PH' }, [
            [[-100, 200]],
          ]),
        ]),
      },
      createIdRegistry(),
      { z: 16, x: 55192, y: 30266 },
    );
    expect([...life.flagpoles!]).toEqual([100, 200, 1]);
  });

  describe('trees', () => {
    const tile = { z: 16, x: 55_194, y: 30_268 };
    const units = (meters: number) => meters / metersPerUnit(tile);
    const tree = (props: Record<string, unknown> = {}) =>
      feature(1, { id: 'osm:node/40', class: 'tree', height: 10, crown: 8, ...props }, [
        [[2000, 2000]],
      ]);
    const build = (f: TileFeatureLike) =>
      buildTileGeometry({ poi: layer([f]) }, createIdRegistry(), tile);

    it('draws a crown of its diameter around the tree', () => {
      const { crowns, fills, points } = build(tree());
      // Crowns are kept apart from the ground: the crown pass redraws them as they sway.
      expect(fills.positions).toHaveLength(0);
      const crown = vertices(crowns);
      expect(crown).toHaveLength(CROWN_SIDES + 1);
      expect(crown.every((v) => v.cls === classId('tree_crown'))).toBe(true);
      const radii = crown.slice(1).map((v) => Math.hypot(v.x! - 2000, v.y! - 2000));
      const mean = radii.reduce((a, b) => a + b, 0) / radii.length;
      expect(mean / units(4)).toBeGreaterThan(0.96);
      expect(mean / units(4)).toBeLessThan(1.04);
      expect(crowns.indices).toHaveLength(CROWN_SIDES * 3);
      expect(Array.from(crowns.surface.slice(0, 2))).toEqual([0, 0]);
      expect(crowns.surface).toHaveLength(crown.length * 2);
      for (let i = 2; i < crowns.surface.length; i += 2)
        expect(Math.hypot(crowns.surface[i]!, crowns.surface[i + 1]!)).toBeCloseTo(1);
      // Each vertex carries its reach from the trunk, how far it swings.
      Array.from(crowns.ridge).forEach((reach, i) => {
        expect(reach).toBeCloseTo(Math.hypot(crown[i]!.x! - 2000, crown[i]!.y! - 2000), -0.5);
      });
      // The tree itself still claims the center cell, with its kind.
      expect(vertices(points)).toEqual([expect.objectContaining({ cls: classId('tree') })]);
    });

    it('draws no crown without a size or a tile to measure it in', () => {
      expect(build(tree({ crown: undefined })).crowns.positions).toHaveLength(0);
      const { crowns } = buildTileGeometry({ poi: layer([tree()]) }, createIdRegistry());
      expect(crowns.positions).toHaveLength(0);
    });

    it('keeps the visible crown inside the parking exclusion through storm wind and recoil', () => {
      const { crowns, life } = build(tree());
      const exclusions = life.areas!.filter((a) => a.kind === 'parking-exclusion');
      expect(exclusions).toHaveLength(1);
      const maxWind = WIND_PRESETS.storm * (1 + WIND_VARIATION.breathe);
      for (const metersPerCell of [0.2, 0.6, 1.5]) {
        const unitsPerCell = units(metersPerCell);
        for (let i = 1; i < crowns.positions.length / 2; i++) {
          for (const [gust, wake] of [
            [maxWind, 0],
            [0, maxWind],
            [maxWind / 2, maxWind / 2],
          ]) {
            for (const time of [0, 0.3, 1]) {
              const [dx, dy] = swayOffset(
                crowns.ridge[i]! / unitsPerCell,
                gust!,
                wake!,
                time,
                i % 13,
              );
              expect(
                pointInside(
                  {
                    x: crowns.positions[2 * i]! + dx * unitsPerCell,
                    y: crowns.positions[2 * i + 1]! + dy * unitsPerCell,
                  },
                  exclusions[0]!.rings,
                ),
              ).toBe(true);
            }
          }
        }
      }
    });

    it('spaces a tree row’s crowns a crown apart', () => {
      const row = feature(2, { id: 'osm:way/41', class: 'tree', height: 10, crown: 8 }, [
        [
          [1000, 1000],
          [1000 + Math.round(units(40)), 1000],
        ],
      ]);
      const { crowns, life } = buildTileGeometry(
        { landuse: layer([row]) },
        createIdRegistry(),
        tile,
      );
      // At 0, 8, 16, 24, 32, and 40 m.
      expect(vertices(crowns)).toHaveLength(6 * (CROWN_SIDES + 1));
      expect(life.areas!.filter((a) => a.kind === 'parking-exclusion')).toHaveLength(6);
    });

    it('gives each tree its own lumpy crown, the same wherever it is built', () => {
      const ring = crownRing({ x: 0, y: 0 }, 100, 7);
      expect(ring).toHaveLength(CROWN_SIDES + 1);
      expect(ring.at(-1)).toEqual(ring[0]);
      const radii = ring.slice(0, -1).map((p) => Math.hypot(p.x, p.y));
      const mean = radii.reduce((a, b) => a + b, 0) / radii.length;
      expect(mean).toBeCloseTo(100, 6);
      for (const r of radii) {
        expect(r).toBeGreaterThan(70);
        expect(r).toBeLessThan(130);
      }
      // Not a circle.
      expect(Math.max(...radii) - Math.min(...radii)).toBeGreaterThan(10);
      expect(crownRing({ x: 0, y: 0 }, 100, 7)).toEqual(ring);
      expect(crownRing({ x: 0, y: 0 }, 100, 8)).not.toEqual(ring);
      expect(ringTriangles(ring)).toHaveLength((CROWN_SIDES - 2) * 3);
    });

    it('seeds a crown by its tree, so the same tree keeps its shape across tiles', () => {
      const a = vertices(build(tree()).crowns);
      const b = vertices(build(tree({ id: 'osm:node/41' })).crowns);
      expect(vertices(build(tree()).crowns)).toEqual(a);
      expect(b).not.toEqual(a);
      expect(hashString('osm:node/40')).toBe(hashString('osm:node/40'));
      expect(hashString('osm:node/40')).not.toBe(hashString('osm:node/41'));
    });

    it('gives the crowns along a tree row different shapes', () => {
      const row = feature(2, { id: 'osm:way/42', class: 'tree', height: 10, crown: 8 }, [
        [
          [1000, 1000],
          [1000 + Math.round(units(16)), 1000],
        ],
      ]);
      const { crowns } = buildTileGeometry({ landuse: layer([row]) }, createIdRegistry(), tile);
      const v = vertices(crowns);
      const size = CROWN_SIDES + 1;
      // Each crown's shape relative to its own center (its trees are 8 m apart along x).
      const shape = (i: number) =>
        v.slice(i * size, (i + 1) * size).map((p) => [p.x! - v[i * size]!.x!, p.y!]);
      expect(v.length).toBeGreaterThanOrEqual(2 * size);
      expect(shape(1)).not.toEqual(shape(0));
    });

    it('walks a line in equal steps, around its bends', () => {
      const line = [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ];
      expect(pointsAlong(line, 4)).toEqual([
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 8, y: 0 },
        { x: 10, y: 2 },
        { x: 10, y: 6 },
        { x: 10, y: 10 },
      ]);
      expect(pointsAlong(line, 0)).toEqual([]);
    });

    it('records the tree kind in the variant byte', () => {
      expect(variantCode('tree', 'palm')).toBe(1);
      expect(variantCode('tree', 'needleleaved')).toBe(2);
      expect(variantCode('trees', 'broadleaved')).toBe(3);
      expect(variantCode('tree', 'baobab')).toBe(0);
    });
  });

  it('centers a pitched roof frame on the long axis, with south-positive across distance', () => {
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
    expect(wide.cx).toBeCloseTo(100);
    expect(wide.cy).toBeCloseTo(30);
    // The light comes from the south (y grows southward), so the south slope is lit.
    expect(wide.ux).toBeCloseTo(1);
    expect(wide.uy).toBeCloseTo(0);
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
    expect(tall.cx).toBeCloseTo(30);
    expect(tall.cy).toBeCloseTo(100);
  });

  it('gives pitched roofs a surface and flag while leaving the obsolete ridge distance zero', () => {
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
    expect([...fills.ridge].every((d) => d === 0)).toBe(true);
    expect([...fills.surface!.slice(0, 20)].some((d) => d !== 0)).toBe(true);
    expect([...fills.surface!.slice(20)].every((d) => d === 0)).toBe(true);
  });
});

describe('buildTileGeometry life', () => {
  const tile = { z: 16, x: 55192, y: 30266 };

  it('starts junction splitting at the existing z13 Life tile boundary', () => {
    for (const z of [12, 13]) {
      const { life } = buildTileGeometry(
        {
          roads: layer([
            feature(2, { class: 'road_mid', id: 'through', width: 10 }, [
              [
                [100, 200],
                [200, 200],
                [300, 200],
              ],
            ]),
            feature(2, { class: 'road_minor', id: 'side', width: 6 }, [
              [
                [200, 200],
                [200, 300],
              ],
            ]),
          ]),
        },
        createIdRegistry(),
        { z, x: tile.x >> (16 - z), y: tile.y >> (16 - z) },
      );
      expect(life.kinds).toHaveLength(z === 12 ? 2 : 3);
      expect(life.spawnGroups === undefined).toBe(z === 12);
    }
  });

  it('protects production signal lookahead beyond the weaker 40-metre clearance', () => {
    const junction = 1000 + 62 / metersPerUnit(tile);
    const { life } = buildTileGeometry(
      {
        roads: layer([
          feature(2, { class: 'road_mid', id: 'through', width: 10 }, [
            [
              [500, 2000],
              [junction, 2000],
              [3000, 2000],
            ],
          ]),
          feature(2, { class: 'road_minor', id: 'side', width: 6 }, [
            [
              [junction, 1000],
              [junction, 2000],
              [junction, 3000],
            ],
          ]),
        ]),
        poi: layer([
          feature(
            1,
            {
              id: 'signal',
              class: 'furniture',
              variant: 'signals',
              signal_radius: 6,
              signal_a: 90,
              signal_b: 0,
              life_signal: 'mapped',
            },
            [[[1000, 2000]]],
          ),
        ]),
      },
      createIdRegistry(),
      tile,
    );
    expect(Array.from(life.kinds)).toEqual([LifeLine.roadMid, LifeLine.roadMinor]);
    expect(life.spawnGroups).toBeUndefined();
  });

  it('makes shared interior road vertices routable in production geometry', () => {
    const { life } = buildTileGeometry(
      {
        roads: layer([
          feature(2, { class: 'road_mid', id: 'through', width: 10, oneway: 1 }, [
            [
              [100, 200],
              [200, 200],
              [300, 200],
            ],
          ]),
          feature(2, { class: 'road_mid', id: 'cross', width: 8, oneway: -1 }, [
            [
              [200, 100],
              [200, 200],
              [200, 300],
            ],
          ]),
        ]),
      },
      createIdRegistry(),
      tile,
    );
    const roads = Array.from(life.kinds.keys()).filter(
      (line) => life.kinds[line] === LifeLine.roadMid,
    );
    expect(roads).toHaveLength(4);
    expect(roads.map((line) => life.lineIds![line])).toEqual([
      hashString('through'),
      hashString('through'),
      hashString('cross'),
      hashString('cross'),
    ]);
    expect(roads.map((line) => life.widths[line])).toEqual([10, 10, 8, 8]);
    expect(roads.map((line) => life.oneway![line])).toEqual([1, 1, -1, -1]);
    for (const line of roads) {
      const ends = [life.starts[line]!, life.starts[line + 1]! - 1];
      expect(ends.some((v) => life.coords[v * 2] === 200 && life.coords[v * 2 + 1] === 200)).toBe(
        true,
      );
    }
  });

  it('keeps roads, paths, and rivers as life lines, and parks as plazas and roosts', () => {
    const g = buildTileGeometry(
      {
        roads: layer([
          feature(2, { class: 'road_major', id: 'r1', width: 12 }, [
            [
              [0, 10],
              [100, 10],
            ],
          ]),
          feature(2, { class: 'path', id: 'p1' }, [
            [
              [0, 20],
              [50, 20],
            ],
          ]),
          // Region-only features have no life.
          feature(2, { class: 'road_major', id: 'r2', region: true }, [
            [
              [0, 30],
              [100, 30],
            ],
          ]),
        ]),
        landuse: layer([feature(3, { class: 'park', id: 'k1' }, [square(1000, 1000, 200)])]),
      },
      createIdRegistry(),
      tile,
    );
    const { life } = g;
    expect(Array.from(life.kinds)).toEqual([LifeLine.roadMajor, LifeLine.path, LifeLine.plaza]);
    expect(Array.from(life.starts)).toEqual([0, 2, 4, 9]);
    // Roads carry their width, for the lanes vehicles keep to.
    expect(Array.from(life.widths)).toEqual([12, 0, 0]);
    expect(Array.from(life.coords.slice(0, 4))).toEqual([0, 10, 100, 10]);
    expect(Array.from(life.roosts)).toEqual([1100, 1100]);
  });

  it('lines major and secondary roads with streetlights, not side streets', () => {
    const road = (cls: string, id: string, y: number) =>
      feature(2, { class: cls, id }, [
        [
          [0, y],
          [2000, y],
        ],
      ]);
    const lampsOn = (cls: string) =>
      buildTileGeometry({ roads: layer([road(cls, 'r', 500)]) }, createIdRegistry(), tile).life
        .lamps.length;
    expect(lampsOn('road_major')).toBeGreaterThan(0);
    expect(lampsOn('road_mid')).toBeGreaterThan(0);
    expect(lampsOn('road_minor')).toBe(0);
  });

  it('lights shops and markets, as areas or points, in the tile that holds them', () => {
    const g = buildTileGeometry(
      {
        buildings: layer([
          feature(3, { class: 'building_market', id: 'm' }, [square(1000, 1000, 200)]),
          feature(1, { class: 'building_market', id: 's' }, [[[3000, 3000]]]),
          feature(3, { class: 'building', id: 'b' }, [square(2000, 2000, 200)]),
        ]),
      },
      createIdRegistry(),
      tile,
    );
    const shops = Array.from(g.life.shops);
    expect(shops).toHaveLength(6);
    expect(shops.slice(0, 2)).toEqual([1100, 1100]);
    expect(shops[2]).toBeCloseTo(Math.hypot(100, 100));
    expect(shops.slice(3, 5)).toEqual([3000, 3000]);
  });

  it('floodlights landmarks over their footprint, in the tile that holds them', () => {
    const g = buildTileGeometry(
      {
        buildings: layer([
          feature(3, { class: 'building_religious', id: 'c', landmark: true }, [
            square(1000, 1000, 200),
          ]),
          feature(3, { class: 'building', id: 'b' }, [square(2000, 2000, 200)]),
          // In the neighbor's buffer: that tile floodlights it.
          feature(3, { class: 'building_religious', id: 'x', landmark: true }, [
            square(-400, 1000, 200),
          ]),
        ]),
      },
      createIdRegistry(),
      tile,
    );
    const floods = Array.from(g.life.floods);
    expect(floods).toHaveLength(3);
    expect(floods[0]).toBeCloseTo(1100);
    expect(floods[1]).toBeCloseTo(1100);
    // Out to its corners.
    expect(floods[2]).toBeCloseTo(Math.hypot(100, 100));
  });

  it('marks markets, as areas or points, where street vendors gather', () => {
    const g = buildTileGeometry(
      {
        buildings: layer([
          feature(3, { id: 'm1', class: 'building_market' }, [square(100, 100, 200)]),
          feature(3, { id: 'b1', class: 'building' }, [square(600, 600, 100)]),
        ]),
        poi: layer([feature(1, { id: 'm2', class: 'building_market' }, [[[900, 40]]])]),
      },
      createIdRegistry(),
      tile,
    );
    expect(Array.from(g.life.markets).sort((a, b) => a - b)).toEqual([40, 200, 200, 900]);
  });

  it('marks places people gather at, owned by the tile that holds them', () => {
    const g = buildTileGeometry(
      {
        buildings: layer([
          feature(3, { id: 'c1', class: 'building_religious', height: 12 }, [
            square(100, 100, 200),
          ]),
          // Grounds: no height.
          feature(3, { id: 's1', class: 'building_school' }, [square(1000, 1000, 400)]),
          // In the neighbor's buffer: that tile has it.
          feature(3, { id: 'c2', class: 'building_religious', height: 12 }, [
            square(-400, 100, 200),
          ]),
          feature(3, { id: 'b1', class: 'building', height: 6 }, [square(600, 600, 100)]),
        ]),
        landuse: layer([feature(3, { id: 'f1', class: 'farmland' }, [square(2000, 2000, 800)])]),
        poi: layer([
          feature(1, { id: 'p1', class: 'furniture', variant: 'bench' }, [[[50, 60]]]),
          feature(1, { id: 'p2', class: 'furniture', variant: 'fountain' }, [[[70, 80]]]),
          feature(1, { id: 'p3', class: 'furniture', variant: 'flagpole' }, [[[90, 90]]]),
          feature(1, { id: 'p4', class: 'monument' }, [[[300, 900]]]),
        ]),
      },
      createIdRegistry(),
      tile,
    );
    type Place = {
      kind: string | undefined;
      x?: number;
      y?: number;
      radius?: number;
      building?: number;
    };
    const places: Place[] = [];
    for (let i = 0; i < g.life.places.length; i += PLACE_STRIDE) {
      const [x, y, code, radius, building] = g.life.places.slice(i, i + PLACE_STRIDE);
      places.push({ kind: PLACE_CODES[code!], x, y, radius, building });
    }
    const byKind: Partial<Record<string, Place>> = Object.fromEntries(
      places.map((p): [string, Place] => [p.kind ?? '', p]),
    );
    expect(places.map((p) => p.kind).sort()).toEqual(
      ['bench', 'farm', 'fountain', 'monument', 'school', 'worship'].sort(),
    );
    expect(byKind.worship).toMatchObject({ x: 200, y: 200, building: 1 });
    expect(byKind.worship!.radius).toBeCloseTo(200 / Math.sqrt(Math.PI));
    expect(byKind.school).toMatchObject({ x: 1200, y: 1200, building: 0 });
    expect(byKind.bench).toMatchObject({ x: 50, y: 60, radius: 0 });
  });

  it('gives canals, not other streams, to boats', () => {
    const g = buildTileGeometry(
      {
        water: layer([
          feature(2, { id: 'w1', class: 'water_stream', kind: 'waterway=canal' }, [
            [
              [0, 100],
              [4000, 100],
            ],
          ]),
          feature(2, { id: 'w2', class: 'water_stream', kind: 'waterway=stream' }, [
            [
              [0, 900],
              [4000, 900],
            ],
          ]),
        ]),
      },
      createIdRegistry(),
      tile,
    );
    expect(Array.from(g.life.kinds)).toEqual([LifeLine.canal]);
  });

  it('skips roosts that fall in the tile buffer', () => {
    const g = buildTileGeometry(
      { landuse: layer([feature(3, { class: 'trees', id: 't1' }, [square(-300, 10, 100)])]) },
      createIdRegistry(),
      tile,
    );
    expect(g.life.roosts).toHaveLength(0);
  });
});

describe('parkingStalls', () => {
  const tile = { z: 16, x: 55192, y: 30266 };
  const unitMeters = metersPerUnit(tile);
  const lot = (x: number, y: number, w: number, h: number) => [
    [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
      { x, y },
    ],
  ];

  it('lays rows of stalls along a lot’s long side, inside it', () => {
    const stalls = parkingStalls(lot(1000, 1000, 600, 150), unitMeters);
    const long = 600 * unitMeters;
    const across = 150 * unitMeters;
    expect(stalls.length).toBe(
      Math.floor(long / STALL.width) * Math.max(1, Math.floor(across / STALL.row)),
    );
    for (const { p, hx, hy } of stalls) {
      expect(p.x).toBeGreaterThan(1000);
      expect(p.x).toBeLessThan(1600);
      expect(p.y).toBeGreaterThan(1000);
      expect(p.y).toBeLessThan(1150);
      // Facing across the rows.
      expect(Math.abs(hx)).toBeCloseTo(0);
      expect(Math.abs(hy)).toBeCloseTo(1);
    }
  });

  it('drops stalls in the tile buffer', () => {
    expect(parkingStalls(lot(-400, 1000, 300, 150), unitMeters)).toHaveLength(0);
  });

  it('reaches the life geometry from parking areas', () => {
    const g = buildTileGeometry(
      { landuse: layer([feature(3, { class: 'parking', id: 'pk' }, [square(1000, 1000, 300)])]) },
      createIdRegistry(),
      tile,
    );
    expect(g.life.spots.length).toBeGreaterThan(0);
    expect(g.life.spots.length % 4).toBe(0);
  });
});

describe('local scene geometry', () => {
  const tile = { z: 16, x: 55192, y: 30266 };
  it('owns a stable site anchor once, independent of clipped render geometry', () => {
    const [lng, lat] = tileToLngLat(tile, { x: 1000, y: 2000 });
    const stop = feature(
      1,
      {
        class: 'furniture',
        id: 's',
        life_site: 'stop',
        life_modes: 2,
        life_covered: true,
        life_lng: lng,
        life_lat: lat,
      },
      [[[3000, 3000]]],
    );
    const g = buildTileGeometry({ poi: layer([stop]) }, createIdRegistry(), tile);
    expect(Array.from(g.life.sites)).toEqual([1000, 2000, 0, 2, 1]);
    const adjacent = buildTileGeometry({ poi: layer([stop]) }, createIdRegistry(), {
      ...tile,
      x: tile.x + 1,
    });
    expect(adjacent.life.sites).toHaveLength(0);
  });
  it('emits solid buildings, water, and fences as walking obstacles, but not grounds', () => {
    const g = buildTileGeometry(
      {
        buildings: layer([
          feature(3, { class: 'building', height: 6 }, [square(100, 100, 30)]),
          feature(3, { class: 'building_school' }, [square(200, 100, 30)]),
        ]),
        water: layer([feature(3, { class: 'water_area' }, [square(300, 100, 30)])]),
        poi: layer([
          feature(2, { class: 'barrier' }, [
            [
              [400, 100],
              [400, 200],
            ],
          ]),
        ]),
      },
      createIdRegistry(),
      tile,
    );
    expect(Array.from(g.life.obstacleClosed)).toEqual([1, 1, 0]);
    expect(g.life.obstacleStarts).toHaveLength(4);
  });
});
