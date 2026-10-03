import { describe, expect, it, vi } from 'vitest';
import { buildTileGeometry, createIdRegistry, type TileFeatureLike } from './raster/geometry';
import { pointInside } from './life/occupancy';
import { random } from './life/random';
import { project } from './camera';
import { placeGrid, type View } from './grid';
import type { TileId } from './tiles';
import { FIREWORKS, createFireworkDisplay, fireworkShells } from './fireworks-layout';
import {
  isResidentialBuilding,
  residentialFireworkSites,
  residentialSite,
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
const decode = (features: TileFeatureLike[], tile?: TileId) =>
  buildTileGeometry(
    { buildings: { extent: 4096, length: features.length, feature: (i) => features[i]! } },
    createIdRegistry(),
    tile,
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
      expect(decode([...houses, road(kind)], tile).residential).toBeUndefined();
    expect(
      decode([houses[0]!, houses[1]!, road('highway=residential')], tile).residential,
    ).toBeUndefined();
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
    ).toBeUndefined();
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
