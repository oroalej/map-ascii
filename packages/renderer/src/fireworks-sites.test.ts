import { describe, expect, it, vi } from 'vitest';
import {
  buildTileGeometry,
  buildResidentialSites,
  transferables,
  createIdRegistry,
  type TileFeatureLike,
} from './raster/geometry';
import { pointInside } from './life/occupancy';
import { random } from './life/random';
import { project } from './camera';
import { placeGrid, type View } from './grid';
import type { TileId } from './tiles';
import { FIREWORKS, createFireworkDisplay, fireworkShells } from './fireworks-layout';
import {
  isResidentialBuilding,
  residentialFireworkSites as compileSites,
  residentialSite,
  neighborhoodSites,
  packResidentialSites,
  type ResidentialSite,
} from './fireworks-sites';

const square = (x: number, y: number, size: number) => [
  { x, y },
  { x: x + size, y },
  { x: x + size, y: y + size },
  { x, y: y + size },
  { x, y },
];
const feature = (
  id: string,
  kind: string,
  rings = [square(1000, 1000, 200)],
  cls = 'building',
): TileFeatureLike => ({
  type: 3,
  properties: { id, class: cls, kind, height: 4 },
  loadGeometry: () => rings,
});
const layers = (features: TileFeatureLike[]) => ({
  buildings: { extent: 4096, length: features.length, feature: (i: number) => features[i]! },
});
const decode = (features: TileFeatureLike[], tile?: TileId) => {
  const geometry = buildTileGeometry(
    { buildings: { extent: 4096, length: features.length, feature: (i) => features[i]! } },
    createIdRegistry(),
    tile,
  );
  const packed = geometry.residential;
  return {
    ...geometry,
    residential: packed
      ? Array.from({ length: packed.length / 3 }, (_, i) => ({
          id: packed[i * 3]!,
          x: packed[i * 3 + 1]!,
          y: packed[i * 3 + 2]!,
        }))
      : undefined,
  };
};
const residentialFireworkSites = (
  tiles: { tile: TileId; sites: readonly ResidentialSite[] }[],
  zoom: number,
) =>
  compileSites(
    tiles.map(({ tile, sites }) => ({ tile, sites: packResidentialSites(sites) })),
    zoom,
  );
const view: View = {
  camera: { lng: 0, lat: 0, zoom: 16 },
  dpr: 1,
  width: 1000,
  height: 800,
  cellDev: { w: 5, h: 9 },
  labelDev: { w: 10, h: 18 },
  detailZoom: 16,
};
const grid = (v = view) => placeGrid(v, v.cellDev, 202, 92).grid;
const bounds = { left: 0, top: 0, right: 512, bottom: 512 };

describe('mapped residential fireworks', () => {
  it('bypasses inference for packs without fireworks and transfers packed anchors exactly', () => {
    const data = layers([feature('home', 'building=house')]);
    const disabled = buildTileGeometry(data, createIdRegistry(), undefined, undefined, false);
    expect(disabled.residential).toBeUndefined();
    const enabled = buildTileGeometry(data, createIdRegistry());
    expect(enabled.residential).toBeInstanceOf(Float64Array);
    expect(transferables(enabled)).toContain(enabled.residential!.buffer);
    expect(enabled.fills.positions).toEqual(disabled.fills.positions);
    const transferred = structuredClone(enabled, { transfer: transferables(enabled) });
    expect(enabled.residential!.byteLength).toBe(0);
    expect(transferred.residential).toHaveLength(3);
    expect(transferred.residential![0]).toBe(1);
  });

  it('matches exact neighborhood admission across long segments and signed cell boundaries', () => {
    const roofs = Array.from({ length: 180 }, (_, id) => ({
      id,
      x: ((id % 18) - 9) * 20,
      y: (Math.floor(id / 18) - 5) * 20,
    }));
    const streets = [
      [
        { x: -3000, y: -3000 },
        { x: 3000, y: 3000 },
      ],
      [
        { x: -350, y: 35 },
        { x: 350, y: 35 },
      ],
      [
        { x: 0, y: 0 },
        { x: 0, y: 0 },
      ],
    ];
    const near = roofs.filter((roof) =>
      streets.some((street) =>
        street.slice(1).some((b, i) => {
          const a = street[i]!,
            dx = b.x - a.x,
            dy = b.y - a.y,
            length = dx * dx + dy * dy;
          const t = length
            ? Math.max(0, Math.min(1, ((roof.x - a.x) * dx + (roof.y - a.y) * dy) / length))
            : 0;
          return (roof.x - a.x - t * dx) ** 2 + (roof.y - a.y - t * dy) ** 2 <= 35 ** 2;
        }),
      ),
    );
    const expected = near.filter(
      (site) =>
        near.filter(
          (other) =>
            other.id !== site.id && (site.x - other.x) ** 2 + (site.y - other.y) ** 2 <= 60 ** 2,
        ).length >= 2,
    );
    expect(neighborhoodSites(roofs, [], streets, 1)).toEqual(expected);
    expect(
      neighborhoodSites(
        roofs,
        [],
        streets.map((line) => [...line].reverse()),
        1,
      ),
    ).toEqual(expected);
  });

  it('extracts cold coarse coverage without ground buffers, using the same footprint and inference rules', () => {
    const tile = { z: 16, x: 32768, y: 32768 };
    const homes = [
      feature('known', 'building=house'),
      ...[1000, 1150, 1300].map((x, i) =>
        feature(`unknown/${i}`, 'building=yes', [square(x, 1600, 60)]),
      ),
      feature('public', 'building=yes', [square(1000, 1600, 60)]),
    ];
    homes.at(-1)!.properties.landmark = true;
    homes.push({
      type: 2,
      properties: { class: 'road_minor', kind: 'highway=residential', id: 'road' },
      loadGeometry: () => [
        [
          { x: 900, y: 1610 },
          { x: 1450, y: 1610 },
        ],
      ],
    });
    const registry = createIdRegistry();
    const full = buildTileGeometry(layers(homes), registry, tile);
    const coverage = buildResidentialSites(layers(homes), registry, tile);
    expect(coverage).toEqual(full.residential);
    expect(coverage).toHaveLength(12);
    expect(buildResidentialSites(layers([]), registry, tile)).toHaveLength(0);
  });

  it('samples full and partial spatial bins uniformly and excludes occupied homes', () => {
    const homes = Array.from({ length: 40 }, (_, id) => ({
      id,
      x: (id % 8) * 512 + 20,
      y: Math.floor(id / 8) * 512 + 20,
    }));
    const sample = residentialFireworkSites([{ tile: { z: 12, x: 0, y: 0 }, sites: homes }], 12);
    const occupied = new Set([0, 1, 9, 17]);
    const area = { left: 0, top: 0, right: 350, bottom: 200 };
    const eligible = homes.filter(
      (home) => home.x / 8 <= area.right && home.y / 8 <= area.bottom && !occupied.has(home.id),
    );
    const choices = new Map<number, number>(),
      rng = random(13579);
    for (let i = 0; i < 5000; i++) {
      const site = sample(area, rng, occupied)!;
      choices.set(site.id, (choices.get(site.id) ?? 0) + 1);
    }
    expect([...choices.keys()].sort((a, b) => a - b)).toEqual(eligible.map((home) => home.id));
    for (const count of choices.values())
      expect(count).toBeGreaterThan((5000 / eligible.length) * 0.6);
  });
  it('selects within a full bin without retrying occupied positions', () => {
    const sample = residentialFireworkSites(
      [
        {
          tile: { z: 12, x: 0, y: 0 },
          sites: [
            { id: 1, x: 10, y: 10 },
            { id: 2, x: 20, y: 20 },
            { id: 3, x: 30, y: 30 },
          ],
        },
      ],
      12,
    );
    const rng = vi.fn(() => 0);
    expect(sample({ left: 0, top: 0, right: 512, bottom: 512 }, rng, new Set([1, 2]))?.id).toBe(3);
    expect(rng).toHaveBeenCalledTimes(2);
  });
  it('bounds dense neighborhood sampling work and observes mutations of the same occupancy set', () => {
    const homes = Array.from({ length: 6700 }, (_, id) => ({
      id,
      x: (id % 100) * 40 + 20,
      y: Math.floor(id / 100) * 60 + 20,
    }));
    const sample = residentialFireworkSites([{ tile: { z: 12, x: 0, y: 0 }, sites: homes }], 12);
    const area = { left: 120, top: 120, right: 390, bottom: 390 };
    const occupied = new Set<number>();
    const has = vi.spyOn(occupied, 'has');
    const rng = vi.fn(random(19));
    for (let i = 0; i < 50; i++) {
      const site = sample(area, rng, occupied)!;
      expect(site).toBeDefined();
      expect(site.x).toBeGreaterThanOrEqual(area.left);
      expect(site.x).toBeLessThanOrEqual(area.right);
      expect(site.y).toBeGreaterThanOrEqual(area.top);
      expect(site.y).toBeLessThanOrEqual(area.bottom);
      expect(occupied).not.toContain(site.id);
      occupied.add(site.id);
    }
    expect(has.mock.calls.length).toBeLessThan((50 * homes.length) / 3);
    expect(rng.mock.calls.length).toBeLessThan(50_000);
    has.mockRestore();
    const all = { left: 0, top: 0, right: 512, bottom: 512 };
    occupied.clear();
    for (const home of homes) occupied.add(home.id);
    expect(sample(all, random(1), occupied)).toBeUndefined();
    occupied.delete(3001);
    expect(sample(all, random(1), occupied)?.id).toBe(3001);
    occupied.delete(3002);
    expect(new Set(Array.from({ length: 100 }, () => sample(all, rng, occupied)!.id))).toEqual(
      new Set([3001, 3002]),
    );
    occupied.add(3001);
    expect(sample(all, rng, occupied)?.id).toBe(3002);
  });
  it('admits compact roof clusters along residential streets, excluding isolated roofs and nonresidential roads', () => {
    const houses = [1000, 1150, 1300].map((x, i) =>
      feature(`untyped/${i}`, 'building=yes', [square(x, 1000, 60)]),
    );
    houses.push(
      feature('isolated', 'building=yes', [square(3000, 1000, 60)]),
      feature('large', 'building=yes', [square(1100, 1000, 300)]),
      feature('shed', 'building=yes', [square(1200, 1000, 10)]),
      feature('commercial', 'building=commercial', [square(1250, 1000, 60)]),
    );
    const road = (kind: string): TileFeatureLike => ({
      type: 2,
      properties: { id: 'road', class: 'road_minor', kind },
      loadGeometry: () => [
        [
          { x: 900, y: 1010 },
          { x: 1450, y: 1010 },
        ],
      ],
    });
    const tile = { z: 16, x: 32768, y: 32768 };
    expect(decode([...houses, road('highway=residential')], tile).residential).toHaveLength(3);
    expect(decode([...houses, road('highway=living_street')], tile).residential).toHaveLength(3);
    for (const kind of ['highway=service', 'highway=unclassified', 'highway=tertiary'])
      expect(decode([...houses, road(kind)], tile).residential).toHaveLength(0);
    expect(
      decode([houses[0]!, houses[1]!, road('highway=residential')], tile).residential,
    ).toHaveLength(0);
  });

  it('admits explicit homes and rejects unknown, commercial, public and field features', () => {
    const kinds = [
      'building=house',
      'building=apartments',
      'building=residential',
      'building=terrace',
      'building=yes',
      'building=commercial',
      'building=school',
      'amenity=hospital',
      'landuse=farmland',
    ];
    const geometry = decode(kinds.map((kind, i) => feature(`home/${i}`, kind)));
    expect(geometry.residential).toHaveLength(4);
    expect(
      decode([feature('field', 'building=house', undefined, 'farmland')]).residential,
    ).toHaveLength(0);
    expect(isResidentialBuilding(undefined)).toBe(false);
    expect(isResidentialBuilding('building=houseboat')).toBe(false);
  });

  it('keeps anchors inside concave footprints and outside courtyards and tile buffers', () => {
    const outline = square(1000, 1000, 600),
      hole = square(1100, 1100, 400).reverse();
    const concave = [
      { x: 2000, y: 1000 },
      { x: 2600, y: 1000 },
      { x: 2600, y: 1200 },
      { x: 2200, y: 1200 },
      { x: 2200, y: 1600 },
      { x: 2000, y: 1600 },
      { x: 2000, y: 1000 },
    ];
    const geometry = decode([
      feature('courtyard', 'building=house', [outline, hole]),
      feature('concave', 'building=house', [concave]),
      feature('buffer', 'building=house', [square(-500, -500, 100)]),
      feature('degenerate', 'building=house', [
        [
          { x: 4, y: 4 },
          { x: 4, y: 4 },
          { x: 4, y: 4 },
        ],
      ]),
    ]);
    expect(geometry.residential).toHaveLength(2);
    const [courtyard, inside] = geometry.residential!;
    expect(pointInside(courtyard!, [outline])).toBe(true);
    expect(pointInside(courtyard!, [hole])).toBe(false);
    expect(pointInside(inside!, [concave])).toBe(true);
    expect(residentialSite(1, [{ x: NaN, y: 0 }], [0, 0, 0], 4096)).toBeUndefined();
  });

  it('deduplicates buffered/parent copies and samples only unoccupied homes within the view', () => {
    const sample = residentialFireworkSites(
      [
        { tile: { z: 0, x: 0, y: 0 }, sites: [{ id: 1, x: 1000, y: 1000 }] },
        {
          tile: { z: 1, x: 0, y: 0 },
          sites: [
            { id: 1, x: 2048, y: 2048 },
            { id: 2, x: 3000, y: 3000 },
          ],
        },
      ],
      0,
    );
    const rng = random(123),
      occupied = new Set<number>();
    const choices = new Map<number, number>();
    for (let i = 0; i < 500; i++) {
      const chosen = sample(bounds, rng, occupied)!;
      choices.set(chosen.id, (choices.get(chosen.id) ?? 0) + 1);
      if (chosen.id === 1) expect(chosen).toEqual({ id: 1, x: 128, y: 128 });
    }
    expect(choices.get(1)).toBeGreaterThan(200);
    expect(choices.get(2)).toBeGreaterThan(200);
    expect(sample({ left: 0, top: 0, right: 10, bottom: 10 }, rng, occupied)).toBeUndefined();
    occupied.add(1);
    occupied.add(2);
    expect(sample(bounds, rng, occupied)).toBeUndefined();
  });

  it('uses one launch per mapped home and keeps its center there through zoom and tile turnover', () => {
    const center = project(view.camera.lng, view.camera.lat, FIREWORKS.referenceZoom);
    const homeTile = { z: FIREWORKS.referenceZoom, x: center[0] / 512, y: center[1] / 512 };
    const homes = [
      { id: 1, x: 1000, y: 1000 },
      { id: 2, x: 2000, y: 2000 },
      { id: 3, x: 3000, y: 1000 },
    ];
    const sample = residentialFireworkSites(
      [{ tile: homeTile, sites: homes }],
      FIREWORKS.referenceZoom,
    );
    const display = createFireworkDisplay(123),
      out = new Float32Array(FIREWORKS.shells * 4);
    expect(fireworkShells(view, grid(), out, display, 0, false, sample)).toBe(3);
    const launches = display.launches.filter((launch) => !!launch);
    expect(new Set(launches.map((launch) => launch.site)).size).toBe(3);
    for (const zoom of [17, 18, 19, 20]) {
      const v = { ...view, camera: { ...view.camera, zoom } },
        g = grid(v);
      // Changed visible tiles cannot relocate in-flight launches into fields.
      const count = fireworkShells(v, g, out, display, 0, false, residentialFireworkSites([], 19));
      for (let i = 0; i < count; i++) {
        const launch = display.launches[display.admitted[i]!]!;
        expect(launches).toContain(launch);
        expect(out[i * 4]).toBeCloseTo(
          launch.x * 2 ** (zoom - 19) - g.originCol * v.cellDev.w - g.shiftX,
          3,
        );
        expect(out[i * 4 + 1]).toBeCloseTo(
          launch.y * 2 ** (zoom - 19) - g.originRow * v.cellDev.h - g.shiftY,
          3,
        );
      }
    }
    expect(
      fireworkShells(view, grid(), out, display, 100, false, residentialFireworkSites([], 19)),
    ).toBe(0);
    expect(out.every((value) => value === 0)).toBe(true);
  });

  it('has no empty-field fallback and bounds missing-site retries, retrying new geography immediately', () => {
    const display = createFireworkDisplay(123),
      out = new Float32Array(FIREWORKS.shells * 4);
    const empty = vi.fn(() => undefined);
    expect(fireworkShells(view, grid(), out, display, 0, false)).toBe(0);
    expect(fireworkShells(view, grid(), out, display, 0, false, empty)).toBe(0);
    const calls = empty.mock.calls.length;
    expect(calls).toBe(FIREWORKS.shells);
    fireworkShells(view, grid(), out, display, 0.1, false, empty);
    expect(empty).toHaveBeenCalledTimes(calls);
    const center = project(view.camera.lng, view.camera.lat, 19);
    // The production sampler respects occupied homes; wrap this one-site fixture likewise.
    expect(
      fireworkShells(view, grid(), out, display, 0.1, false, (_b, _rng, occupied) =>
        occupied.has(1) ? undefined : { id: 1, x: center[0], y: center[1] },
      ),
    ).toBe(1);
    expect(display.launches.filter((launch) => !!launch)).toHaveLength(1);
  });

  it('retries a previously empty reduced-motion view when panning within the same tile set', () => {
    const center = project(view.camera.lng, view.camera.lat, 19);
    const home = { id: 1, x: center[0] + 12000, y: center[1] };
    const sample = residentialFireworkSites(
      [
        {
          tile: { z: 0, x: 0, y: 0 },
          sites: [
            { ...home, x: (home.x / (512 * 2 ** 19)) * 4096, y: (home.y / (512 * 2 ** 19)) * 4096 },
          ],
        },
      ],
      19,
    );
    const display = createFireworkDisplay(123),
      out = new Float32Array(FIREWORKS.shells * 4);
    const original = grid();
    expect(fireworkShells(view, original, out, display, 0, true, sample)).toBe(0);
    const panned = { ...original, shiftX: original.shiftX + 1500 };
    expect(fireworkShells(view, panned, out, display, 0, true, sample)).toBe(1);
    expect(out[0]).toBeCloseTo(view.width / 2, 3);
    const launch = display.launches.find((item) => !!item);
    fireworkShells(view, panned, out, display, 100, true, sample);
    expect(display.launches).toContain(launch);
  });
});
