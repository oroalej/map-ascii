import { simulationSeasons } from './seasonal-simulation';
import { expect, it } from 'vitest';
import type { SeasonConfig, SeasonalDisplayRecord, SeasonalLightStringRecord } from '@atlas/shared';
import { admitsInstallation, festivePulse, installationLamps } from './seasonal-installations';
import { createSeasonalFixtureCache, seasonalFixtures } from './seasonal';
import { LifeBuilder, LifeLine } from './geometry';
import {
  FixturePart,
  packFixtures,
  createFixturePackingScratch,
  type FixtureGrid,
} from './fixtures';
import { mapGlyphs, themes } from '../theme';
import { LifeWorld } from './simulate';
import { LampState } from './lights';
import { worldTiles } from './testing/scenarios';
import { createLifeWorkerApi, runLifeFrame, type FrameInput } from './worker-api';
import { activityLevels } from './config';
import { metersPerUnit, tileToLngLat, lngLatToTile } from '../raster/geometry';
const tile = { z: 16, x: 55192, y: 30266 };
const tree: SeasonalDisplayRecord = {
  version: 1,
  kind: 'christmas-tree',
  id: 'tree',
  season: 'winter',
  installation: 'tree',
  anchor: 'osm:way/1',
  at: tileToLngLat(tile, { x: 2000, y: 2000 }),
  radius_m: 5,
  seed: 19,
};
const string: SeasonalLightStringRecord = {
  version: tree.version,
  season: tree.season,
  anchor: tree.anchor,
  seed: tree.seed,
  kind: 'light-string',
  installation: 'strings',
  id: 'strings',
  from: [tree.at[0] - 0.0001, tree.at[1] + 0.0002],
  to: [tree.at[0] + 0.0001, tree.at[1] + 0.0002],
};
const source = [{ title: 'Reference', url: 'https://example.com/' }];
const season: SeasonConfig = {
  id: 'winter',
  title: { en: 'Winter' },
  status: 'draft',
  note: 'TODO(verify)',
  window: { from: { month: 12, day: 1 }, to: { month: 1, day: 6 } },
  sources: source,
  installations: [
    {
      id: 'tree',
      kind: 'christmas-tree',
      anchor: 'osm:way/1',
      label: 'Decorations',
      radius_m: 5,
      sources: source,
    },
    {
      id: 'strings',
      kind: 'light-string',
      anchor: 'osm:way/1',
      label: 'Decorations',
      layout: 'paths',
      spacing_m: 5,
      sources: source,
    },
  ],
};
const grid: FixtureGrid = {
  cols: 80,
  rows: 80,
  cellWidth: 5,
  cellHeight: 9,
  toCell: (lng, lat) => [
    40 + (lng - tree.at[0]) * 111320 * Math.cos((tree.at[1] * Math.PI) / 180) * 2,
    40 - (lat - tree.at[1]) * 111320,
  ],
};
const index = (glyph: string) => mapGlyphs(themes.dark).indexOf(glyph);
it('reuses seasonal admission scratch, refills ownership and resizes with the target', () => {
  const scratch = createFixturePackingScratch();
  const fixtures = [{ kind: 'season-installation' as const, record: tree }];
  const pack = (target = grid) =>
    packFixtures(
      new Uint8Array(target.cols * target.rows * 4),
      target,
      fixtures,
      20,
      index,
      0,
      undefined,
      undefined,
      scratch,
    );
  const first = pack();
  const admission = scratch.seasonalAdmission;
  admission.fill(99);
  expect(pack().texels).toEqual(first.texels);
  expect(scratch.seasonalAdmission).toBe(admission);
  pack({ ...grid, cols: 100 });
  expect(scratch.seasonalAdmission).not.toBe(admission);
  expect(scratch.seasonalAdmission.length).toBe(100 * grid.rows);
});
it('deduplicates buffered displays, filters unknown definitions and caches tile/config identities', () => {
  const life = new LifeBuilder().finish();
  const groups = [{ tile, life, fixtures: [], seasonal: [tree, string, tree] }];
  const fixtures = seasonalFixtures(groups, season, 13.6);
  expect(fixtures).toHaveLength(2);
  const cache = createSeasonalFixtureCache(),
    first = cache(groups, season, 13.6);
  expect(cache(groups, season, 13.6)).toBe(first);
  expect(cache(groups, { ...season, installations: [] }, 13.6)).toEqual([]);
  expect(cache(groups, undefined, 13.6)).toEqual([]);
  const wrong = { ...tree, anchor: 'osm:way/999' };
  expect(seasonalFixtures([{ ...groups[0]!, seasonal: [wrong] }], season, 13.6)).toEqual([]);
});
it('packs top-down foliage, colored bulbs, centered stars and cords; respects zoom and hardware', () => {
  const fixtures = seasonalFixtures(
    [{ tile, life: new LifeBuilder().finish(), fixtures: [], seasonal: [tree, string] }],
    season,
    13.6,
  );
  const buffer = new Uint8Array(grid.cols * grid.rows * 4);
  const packed = packFixtures(buffer, grid, fixtures, 20, index, 0);
  expect(packed.visibility.seasonal?.installations).toBe(true);
  const parts = new Set(
    Array.from({ length: buffer.length / 4 }, (_, i) => buffer[i * 4 + 1]! & 63),
  );
  expect(parts.has(FixturePart.festiveTree)).toBe(true);
  expect(parts.has(FixturePart.festiveOrnament)).toBe(true);
  expect(parts.has(FixturePart.festiveWire)).toBe(true);
  const center = (40 * grid.cols + 40) * 4;
  expect(buffer[center + 1]! & 63).toBe(FixturePart.festiveOrnament);
  expect(
    packFixtures(buffer, grid, fixtures, 16, index, 0).visibility.seasonal?.installations,
  ).not.toBe(true);
  const lamps = installationLamps(
    fixtures.filter((f) => f.kind === 'season-installation'),
    20,
  );
  expect(lamps).toHaveLength(2);
  expect(installationLamps([], 20)).toEqual([]);
});
it('twinkles asynchronously within bounds and remains constant with reduced motion', () => {
  expect(festivePulse(0, 1)).not.toBe(festivePulse(1, 1));
  expect(festivePulse(1, 1)).not.toBe(festivePulse(1, 2));
  for (let t = 0; t < 20; t += 0.1) {
    expect(festivePulse(t, 19)).toBeGreaterThanOrEqual(0.76);
    expect(festivePulse(t, 19)).toBeLessThanOrEqual(1);
    expect(festivePulse(t, 19, true)).toBe(1);
  }
});
it('admits explicit roof mounting only for matching building layouts and packs separate roof parts', () => {
  const mounted: SeasonalLightStringRecord = { ...string, mount: 'building' };
  const roofSeason: SeasonConfig = {
    ...season,
    installations: [
      {
        ...season.installations![1]!,
        kind: 'light-string',
        layout: 'building-perimeter',
        spacing_m: 3,
      },
    ],
  };
  expect(admitsInstallation(mounted, roofSeason)).toBe(true);
  expect(admitsInstallation(mounted, season)).toBe(false);
  expect(admitsInstallation(string, roofSeason)).toBe(false);
  const groups = [
    { tile, life: new LifeBuilder().finish(), fixtures: [], seasonal: [mounted, mounted] },
  ];
  const fixtures = seasonalFixtures(groups, roofSeason, 13.6);
  expect(fixtures).toHaveLength(1);
  const packed = packFixtures(
    new Uint8Array(grid.cols * grid.rows * 4),
    grid,
    fixtures,
    20,
    index,
    0,
  );
  const parts = new Set(
    Array.from({ length: packed.texels.length / 4 }, (_, i) => packed.texels[i * 4 + 1]! & 63),
  );
  expect(parts.has(FixturePart.buildingLight)).toBe(true);
  expect(parts.has(FixturePart.buildingWire)).toBe(true);
  expect(parts.has(FixturePart.festiveOrnament)).toBe(false);
  expect(
    installationLamps(
      fixtures.filter((f) => f.kind === 'season-installation'),
      20,
    ),
  ).toHaveLength(1);
  expect(seasonalFixtures(groups, undefined, 13.6)).toEqual([]);
  const canopy = { ...string, mount: 'canopy' as const };
  const canopySeason: SeasonConfig = {
    ...season,
    installations: [
      {
        ...season.installations![1]!,
        kind: 'light-string',
        layout: 'perimeter',
        spacing_m: 3,
        mount: 'canopy',
      },
    ],
  };
  expect(admitsInstallation(canopy, canopySeason)).toBe(true);
  expect(admitsInstallation(canopy, season)).toBe(false);
  expect(admitsInstallation(canopy, roofSeason)).toBe(false);
  const hanging = seasonalFixtures([{ ...groups[0]!, seasonal: [canopy] }], canopySeason, 13.6);
  const hung = packFixtures(new Uint8Array(grid.cols * grid.rows * 4), grid, hanging, 20, index, 0);
  const hungParts = new Set(
    Array.from({ length: hung.texels.length / 4 }, (_, i) => hung.texels[i * 4 + 1]! & 63),
  );
  expect(hungParts.has(FixturePart.festiveLight)).toBe(true);
  expect(hungParts.has(FixturePart.buildingLight)).toBe(false);
});
it('preserves lamp hardware and the full animated flag reservation under overlapping displays', () => {
  const lamp = {
    kind: 'streetlight' as const,
    base: tree.at,
    tip: tree.at,
    forward: [tree.at[0] + 0.00001, tree.at[1]] as [number, number],
    right: [tree.at[0], tree.at[1] + 0.00001] as [number, number],
    roadCenter: tree.at,
    state: LampState.working,
    seed: 1,
  };
  const flag = { ...lamp, kind: 'flagpole' as const, flag: 'PH' as const };
  const displays = seasonalFixtures(
    [{ tile, life: new LifeBuilder().finish(), fixtures: [], seasonal: [tree, string] }],
    season,
    13.6,
  );
  for (const hardware of [[lamp], [flag]]) {
    const base = packFixtures(
      new Uint8Array(grid.cols * grid.rows * 4),
      grid,
      hardware,
      20,
      index,
      0,
    );
    const result = packFixtures(
      new Uint8Array(grid.cols * grid.rows * 4),
      grid,
      [...hardware, ...displays],
      20,
      index,
      0,
    );
    for (let i = 0; i < base.texels.length; i += 4)
      if (base.texels[i + 3])
        expect(result.texels.slice(i, i + 4)).toEqual(base.texels.slice(i, i + 4));
  }
});
it('activates/deactivates deduplicated physical footprints independently of stalls', () => {
  const life = { ...new LifeBuilder().finish(), seasonalTrees: [tree, tree] };
  const world = new LifeWorld();
  world.setSeasons(simulationSeasons([season]));
  world.sync([{ key: 'test', tile, life }]);
  const choose = (id: string | null) =>
    world.step(0.001, undefined, 20, undefined, undefined, {
      rain: 0,
      season: id,
    });
  const bodyAt = lngLatToTile(tile, ...tree.at);
  const body = {
    x: bodyAt.x * metersPerUnit(tile),
    y: bodyAt.y * metersPerUnit(tile),
    hx: 1,
    hy: 0,
    length: 1,
    width: 1,
  };
  choose(null);
  expect(world.cellTerrain()!.trees.hits([body])).toBe(false);
  choose('winter');
  expect(world.cellTerrain()!.trees.hits([body])).toBe(true);
  const version = world.cellTerrain()!.version;
  choose('winter');
  expect(world.cellTerrain()!.version).toBe(version);
  choose(null);
  expect(world.cellTerrain()!.trees.hits([body])).toBe(false);
});
it('settles existing actors away from a newly activated physical display', () => {
  const b = new LifeBuilder();
  b.line(
    [
      { x: 500, y: 2000 },
      { x: 3500, y: 2000 },
    ],
    LifeLine.path,
    4,
  );
  const physical = { ...tree, at: [...tree.at] as [number, number] };
  const geo = { ...b.finish(), seasonalTrees: [physical] };
  const world = new LifeWorld();
  world.setSeasons(simulationSeasons([season]));
  world.sync([{ key: 'site', tile, life: geo }]);
  const life = worldTiles(world).get('site')!;
  const person = life.movers.find((m) => m.kind === 'person')!;
  physical.at = tileToLngLat(tile, person);
  world.step(0, undefined, 20, undefined, undefined, {
    rain: 0,
    season: 'winter',
  });
  const trees = world.cellTerrain()!.trees;
  for (const m of life.movers.filter(
    (m) => m.kind === 'person' || m.kind === 'cat' || m.kind === 'dog',
  ))
    expect(trees.hits(life.groundBodies(m))).toBe(false);
});
it('keeps direct and worker frames equivalent through installation activation, eviction and reload', () => {
  const geo = { ...new LifeBuilder().finish(), seasonalTrees: [tree] };
  const tiles = [{ key: 'site', tile, life: geo }];
  const world = new LifeWorld();
  world.setSeasons(simulationSeasons([season]));
  world.sync(tiles);
  const api = createLifeWorkerApi();
  api.init(structuredClone({ processions: [], seasons: simulationSeasons([season]) }));
  api.sync(structuredClone(tiles));
  let snapshots = 0;
  for (let frame = 0; frame < 80; frame++) {
    if (frame === 40) {
      world.sync([]);
      api.sync([]);
    }
    if (frame === 41) {
      world.sync(tiles);
      api.sync(structuredClone(tiles));
    }
    const input: FrameInput = {
      gust: {
        camera: { lng: tree.at[0], lat: tree.at[1], zoom: 20 },
        size: { width: 640, height: 480 },
        cssCell: { w: 5, h: 9 },
        time: frame / 30,
        wind: { dir: [1, 0], strength: 0 },
      },
      step: {
        dt: 1 / 30,
        zoom: 20,
        bounds: undefined,
        wind: undefined,
        weather: {
          rain: 0,
          season: frame < 20 || frame > 30 ? 'winter' : null,
        },
        cellMeters: 0,
      },
      visible: [20, activityLevels(720), tree.at, { rain: 0, sunAltitude: 45 }],
    };
    const direct = runLifeFrame(world, input);
    const result = api.frame(structuredClone(input));
    if (result.terrain !== undefined) snapshots++;
    expect(result.agents).toEqual(direct.agents);
  }
  expect(snapshots).toBe(5);
});
