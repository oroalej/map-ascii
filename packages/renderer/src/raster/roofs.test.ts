import { expect, it } from 'vitest';
import { roofFrame, type RoofPlan } from '@atlas/shared';
import {
  buildTileGeometry,
  createIdRegistry,
  lngLatToTile,
  tileToLngLat,
  transferables,
  type TileFeatureLike,
} from './geometry';
import { classId, Flags, variantCode } from '../classes';
import { plannedSurface, packRoofSurface, roofSurface, RoofShape, type RoofSurface } from './roofs';
import { roofSurfaceCode } from '../glyphs/roofs';

const tile = { z: 16, x: 55193, y: 30264 };
const origin = tileToLngLat(tile, { x: 4080, y: 2000 });
const unit = roofFrame(origin).metersPerTileUnit(tile.z);
const plan: RoofPlan = {
  version: 1,
  origin,
  nodes: [
    { type: 'split', at: [0, 0], angleDeg: 90, negative: 1, positive: 2 },
    {
      type: 'roof',
      center: [60 * unit, 40 * unit],
      angleDeg: 0,
      halfLengthM: 60 * unit,
      halfWidthM: 40 * unit,
    },
    {
      type: 'roof',
      center: [-40 * unit, 100 * unit],
      angleDeg: 90,
      halfLengthM: 100 * unit,
      halfWidthM: 40 * unit,
    },
  ],
};
const ring = [
  [4000, 2000],
  [4200, 2000],
  [4200, 2080],
  [4080, 2080],
  [4080, 2200],
  [4000, 2200],
  [4000, 2000],
];
const building = (
  roof_plan?: string,
  extra: TileFeatureLike['properties'] = {},
): TileFeatureLike => ({
  type: 3,
  properties: {
    id: 'osm:way/1',
    class: 'building',
    height: 6,
    ...extra,
    ...(roof_plan ? { roof_plan } : {}),
  },
  loadGeometry: () => [ring.map(([x, y]) => ({ x: x!, y: y! }))],
});
const build = (features: TileFeatureLike[], z = tile.z) =>
  buildTileGeometry(
    { buildings: { extent: 4096, length: features.length, feature: (i) => features[i]! } },
    createIdRegistry(),
    { ...tile, z },
    16,
  );

it('keeps both wing axes, exact triangulated coverage and unchanged Life/selection identity', () => {
  const normal = build([building()]),
    split = build([building(JSON.stringify(plan))]);
  expect(split.life).toEqual(normal.life);
  expect(split.points).toEqual(normal.points);
  expect(new Set(split.fills.ids)).toEqual(new Set([1]));
  const angles = new Set(Array.from(split.fills.meta).filter((_, i) => i % 4 === 3));
  expect(angles).toEqual(new Set([0, 128]));
  const { positions, indices } = split.fills;
  let area = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i]! * 2,
      b = indices[i + 1]! * 2,
      c = indices[i + 2]! * 2;
    area +=
      Math.abs(
        (positions[b]! - positions[a]!) * (positions[c + 1]! - positions[a + 1]!) -
          (positions[b + 1]! - positions[a + 1]!) * (positions[c]! - positions[a]!),
      ) / 2;
  }
  expect(area).toBe(25600);
});
it('keeps mixed fill surfaces aligned and excludes parts, timber, flat roofs and grounds', () => {
  const features = [
    building(undefined, { id: 'flat', variant: 'flat' }),
    building(),
    building(undefined, { id: 'part', class: 'building_part' }),
    building(undefined, { id: 'wood', class: 'building_woodwork', variant: 'wood' }),
    building(undefined, { id: 'grounds', class: 'building_school', height: 0 }),
  ];
  const geo = build(features),
    fills = geo.fills;
  expect(fills.surfaceSize).toBe(4);
  expect(fills.surface).toBeInstanceOf(Int16Array);
  expect(fills.surface!.byteLength).toBe(fills.ids.length * 8);
  expect(fills.surface).toHaveLength(fills.ids.length * 4);
  for (let i = 0; i < fills.ids.length; i++) {
    const ridged = (fills.meta[i * 4 + 2]! & Flags.ridged) !== 0;
    expect(ridged).toBe(fills.ids[i] === 2);
    if (!ridged) expect(Array.from(fills.surface!.slice(i * 4, i * 4 + 4))).toEqual([0, 0, 0, 0]);
  }
  expect(build([features[0]!]).fills.surface).toBeUndefined();
  expect(build([building()], 14).fills.surface).toBeUndefined();
  expect(fills.meta).toContain(classId('building_woodwork'));
});
it('transfers each roof/crown buffer once and falls back on invalid or old plans', () => {
  const normal = build([building()]);
  for (const value of [
    '{',
    JSON.stringify({ ...plan, version: 2 }),
    JSON.stringify({ ...plan, nodes: [] }),
  ])
    expect(build([building(value)])).toEqual(normal);
  const geo = build([building(JSON.stringify(plan))]);
  const buffers = transferables(geo);
  expect(new Set(buffers).size).toBe(buffers.length);
  const received = structuredClone(geo, { transfer: buffers });
  expect(received.fills.surface!.length).toBe(received.fills.ids.length * 4);
  expect(received.fills.surface).toBeInstanceOf(Int16Array);
  expect(received.fills.surfaceScale).toBe(1 / 64);
  expect(buffers.every((buffer) => buffer.byteLength === 0)).toBe(true);
});

it('packs physical roof faces without changing classification away from derivative boundaries', () => {
  for (const shape of [RoofShape.gabled, RoofShape.hipped, RoofShape.pyramidal]) {
    const samples: RoofSurface[] = [];
    for (const x of [-4, -2, 0, 2, 4])
      for (const y of [-2, -1, 0, 1, 2])
        samples.push(roofSurface({ x, y }, { x: 0, y: 0 }, 0, 5, 3, shape));
    const packed = packRoofSurface(Float32Array.from(samples.flat()), samples.length);
    expect(packed.surface).toBeInstanceOf(Int16Array);
    samples.forEach((sample, i) => {
      const decoded = Array.from(
        packed.surface.slice(i * 4, i * 4 + 4),
        (v, j) => v * (j === 3 ? 1 / 32767 : packed.surfaceScale!),
      ) as RoofSurface;
      expect(roofSurfaceCode(decoded, 0.2, 0.2)).toBe(roofSurfaceCode(sample, 0.2, 0.2));
      decoded.forEach((v, j) =>
        expect(Math.abs(v - sample[j]!)).toBeLessThan(j === 3 ? 1 / 32767 : 1 / 128 + 0.00001),
      );
    });
  }
});
it('extends range without wrapping, zero-fills trailing non-roofs and retains tiny pyramid scales', () => {
  const source = new Float32Array([1000000, -1000000, 500000, 1]);
  const packed = packRoofSurface(source, 2);
  expect(packed.surfaceScale).toBeGreaterThan(1 / 64);
  expect(packed.surface[0]! * packed.surfaceScale!).toBeCloseTo(1000000);
  expect(packed.surface[1]! * packed.surfaceScale!).toBeCloseTo(-1000000);
  expect(Array.from(packed.surface.slice(4))).toEqual([0, 0, 0, 0]);
  const fallback = packRoofSurface(new Float32Array([1, 1, 0, 0.000001]), 2);
  expect(fallback.surface).toBeInstanceOf(Float32Array);
  expect(fallback.surface[3]).toBeGreaterThan(0);
  expect(Array.from(fallback.surface.slice(4))).toEqual([0, 0, 0, 0]);
  const widePyramid = packRoofSurface(new Float32Array([1, 1, 0, 2]), 1);
  expect(widePyramid.surface).toBeInstanceOf(Float32Array);
  expect(widePyramid.surface[3]).toBe(2);
});
it('preserves roof distances across neighboring and parent tiles in one world frame', () => {
  const leaf = plan.nodes[1]!;
  if (leaf.type !== 'roof') throw new Error('fixture');
  const world = tileToLngLat(tile, { x: 4100, y: 2040 });
  const reference = plannedSurface(
    lngLatToTile(tile, ...world),
    leaf,
    plan,
    lngLatToTile(tile, ...origin),
    tile.z,
    3,
  );
  for (const t of [
    { ...tile, x: tile.x + 1 },
    { z: 15, x: Math.floor(tile.x / 2), y: Math.floor(tile.y / 2) },
  ]) {
    const surface = plannedSurface(
      lngLatToTile(t, ...world),
      leaf,
      plan,
      lngLatToTile(t, ...origin),
      t.z,
      3,
    );
    surface.forEach((v, i) => expect(Math.abs(v - reference[i]!)).toBeLessThan(0.05));
  }
});
it('preserves holes while partitioning triangulated geometry', () => {
  const f = building(JSON.stringify(plan));
  const outer = f.loadGeometry()[0]!;
  f.loadGeometry = () => [
    outer,
    [
      { x: 4010, y: 2010 },
      { x: 4010, y: 2030 },
      { x: 4030, y: 2030 },
      { x: 4030, y: 2010 },
      { x: 4010, y: 2010 },
    ],
  ];
  const { fills } = build([f]);
  const inside = (x: number, y: number, a: number, b: number, c: number) => {
    const p = fills.positions;
    const cross = (i: number, j: number) =>
      (p[j * 2]! - p[i * 2]!) * (y - p[i * 2 + 1]!) -
      (p[j * 2 + 1]! - p[i * 2 + 1]!) * (x - p[i * 2]!);
    const signs = [cross(a, b), cross(b, c), cross(c, a)];
    return signs.every((s) => s >= 0) || signs.every((s) => s <= 0);
  };
  for (let i = 0; i < fills.indices.length; i += 3)
    expect(
      inside(4020, 2020, fills.indices[i]!, fills.indices[i + 1]!, fills.indices[i + 2]!),
    ).toBe(false);
});
it('classifies mapped roof shapes without interpreting timber or landmark parts as roofs', () => {
  for (const [value, expected] of [
    [undefined, 3],
    ['flat', 1],
    ['gabled', 2],
    ['hipped', 3],
    ['pyramidal', 4],
    ['dome', 2],
  ] as const)
    expect(variantCode('building', value)).toBe(expected);
  expect(variantCode('furniture', undefined)).toBe(0);
});
