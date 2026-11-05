import { describe, expect, it } from 'vitest';
import {
  lngLatToTile,
  metersPerUnit,
  TILE_EXTENT,
  type HarvestNow,
  type TileAddress,
} from '@atlas/shared';
import { describeAgent } from './describe';
import {
  BIRD_SPECIES,
  BIRD_SPECIES_ORDER,
  BirdPose,
  HABITAT_NAMES,
  Habitat,
  pickSpecies,
} from './birds';
import { packLife, type LifeGrid } from './draw';
import { mapGlyphs, themes } from '../theme';
import { activityLevels } from './config';
import { LifeBuilder } from './geometry';
import { LifeWorld, type VisibleAgent } from './simulate';
import { packFootprints, type LifeGeometry } from './geometry';
import { DRYING_STRIDE } from './palay';
import {
  EMBER_LABEL,
  FIELD_LIFE,
  fieldLife,
  RAKER_LABEL,
  workAnimal,
  type FieldInput,
} from './field-life';
import { VEHICLES } from './vehicles';
import { PUFF_STRIDE } from './exhaust';
import { PALAY_SHOW_SHARE } from './config';

const TILE: TileAddress = { z: 16, x: 55_800, y: 30_200 };
const EAST: TileAddress = { ...TILE, x: TILE.x + 1 };
const square = (x0: number, y0: number, x1: number, y1: number) => [
  [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
    { x: x0, y: y0 },
  ],
];
const WHOLE = square(-200, -200, TILE_EXTENT + 200, TILE_EXTENT + 200);
const geometry = (rings = WHOLE, drying?: number[]) =>
  ({
    fields: packFootprints([{ id: 'field', kind: 'farmland' as const, rings }]),
    ...(drying && { drying: Float32Array.from(drying) }),
  }) as unknown as LifeGeometry;
const SPREAD: HarvestNow = { drying: 1, spread: true, tractors: 0, ducks: 0, burning: false };
const input = (change: Partial<FieldInput> = {}): FieldInput => ({
  tiles: [{ tile: TILE, geo: geometry() }],
  harvest: SPREAD,
  time: 1_000,
  wind: [1, 0],
  birds: 1,
  center: [123.2, 13.62],
  crowd: 1,
  ...change,
});
const STRIPS = [
  100, 100, 400, 100, 1, 0.1, 100, 300, 400, 300, -1, 0.3, 100, 500, 400, 500, 1, 0.9,
];
const onStrips = (change: Partial<FieldInput> = {}) =>
  input({ tiles: [{ tile: TILE, geo: geometry(WHOLE, STRIPS) }], ...change });
const DUCKS: HarvestNow = { ...SPREAD, drying: 0, spread: false, ducks: 1 };
const SMOKE: HarvestNow = { ...SPREAD, drying: 0, spread: false, burning: true };
const named = (label: string, frame: ReturnType<typeof fieldLife>) =>
  frame.agents.filter((a) => a.fieldLabel === label);
const ducks = (frame: ReturnType<typeof fieldLife>) =>
  frame.agents.filter((a) => a.bird?.species === 'duck');

describe('rakers', () => {
  it('puts one on each strip in use, and only while the palay is spread', () => {
    expect(STRIPS.length / DRYING_STRIDE).toBe(3);
    const frame = fieldLife(onStrips());
    expect(named(RAKER_LABEL, frame)).toHaveLength(2);
    expect(fieldLife(onStrips({ harvest: { ...SPREAD, spread: false } })).agents).toEqual([]);
    expect(fieldLife(onStrips({ harvest: { ...SPREAD, drying: 0 } })).agents).toEqual([]);
    // 0.35 of the slots at the peak: at half the drying, the 0.3 strip has gone.
    const half = fieldLife(onStrips({ harvest: { ...SPREAD, drying: 0.5 } }));
    expect(named(RAKER_LABEL, half)).toHaveLength(1);
    expect(0.3).toBeGreaterThan(0.5 * PALAY_SHOW_SHARE);
  });

  it('stays on its strip, going back and forth, drawn as an ordinary adult who is simulated', () => {
    const seen = new Set<number>();
    for (let time = 0; time < 120; time += 5) {
      const [raker] = named(RAKER_LABEL, fieldLife(onStrips({ time })));
      const p = lngLatToTile(TILE, raker!.lng, raker!.lat);
      expect(p.y).toBeCloseTo(100, 1);
      expect(p.x).toBeGreaterThanOrEqual(99.9);
      expect(p.x).toBeLessThanOrEqual(400.1);
      seen.add(Math.round(p.x / 30));
      expect(raker!.kind).toBe('person');
      expect(raker!.vehicle).toBeUndefined();
      expect(raker!.people).toBeUndefined();
    }
    expect(seen.size).toBeGreaterThan(5);
    const [raker] = named(RAKER_LABEL, fieldLife(onStrips()));
    expect(describeAgent(raker!)).toBe('Person raking palay (simulated)');
  });

  it('holds its pose at a fixed time, whatever came before', () => {
    const frame = fieldLife(onStrips());
    fieldLife(onStrips({ time: 3 }));
    expect(fieldLife(onStrips())).toEqual(frame);
  });

  it('respects the crowd knob and the view', () => {
    expect(named(RAKER_LABEL, fieldLife(onStrips({ crowd: 0 })))).toEqual([]);
    expect(named(RAKER_LABEL, fieldLife(onStrips({ crowd: 0.5 })))).toHaveLength(1);
    const away = fieldLife(onStrips({ bounds: [0, 0, 1, 1] }));
    expect(away.agents).toEqual([]);
  });
});

describe('ducks', () => {
  /** A farm tile with enough flocks to look at. */
  const flocks = (change: Partial<FieldInput> = {}) => input({ harvest: DUCKS, ...change });

  it('come only in the stage that calls them, perched, by day', () => {
    const frame = fieldLife(flocks());
    expect(ducks(frame).length).toBeGreaterThan(0);
    expect(fieldLife(input()).agents).toEqual([]);
    expect(fieldLife(flocks({ birds: 0 })).agents).toEqual([]);
    for (const duck of ducks(frame)) {
      expect(duck.bird!.pose).toBe(BirdPose.perched);
      expect(duck.kind).toBe('bird');
      expect(describeAgent(duck)).toBe('Duck (simulated)');
    }
  });

  it('stay inside their field, at any time', () => {
    const half = geometry(square(-200, -200, TILE_EXTENT + 200, 2048));
    for (const time of [0, 500, 5_000, 100_000]) {
      const frame = fieldLife(flocks({ tiles: [{ tile: TILE, geo: half }], time }));
      for (const duck of ducks(frame))
        expect(lngLatToTile(TILE, duck.lng, duck.lat).y).toBeLessThanOrEqual(2048.01);
    }
  });

  it('stay within 20 m of the flock, moving slowly', () => {
    const at = (time: number) => ducks(fieldLife(flocks({ time })));
    const [a, b] = [at(1_000), at(1_001)];
    expect(a.length).toBe(b.length);
    const perUnit = metersPerUnit(TILE);
    for (let i = 0; i < a.length; i++) {
      const p = lngLatToTile(TILE, a[i]!.lng, a[i]!.lat);
      const q = lngLatToTile(TILE, b[i]!.lng, b[i]!.lat);
      expect(Math.hypot(p.x - q.x, p.y - q.y) * perUnit).toBeLessThan(0.8);
    }
  });

  it('are capped, and keep a nearest-first order whichever way tiles are listed', () => {
    const tiles = [
      { tile: TILE, geo: geometry() },
      { tile: EAST, geo: geometry() },
      { tile: { ...TILE, y: TILE.y + 1 }, geo: geometry() },
      { tile: { ...EAST, y: TILE.y + 1 }, geo: geometry() },
    ];
    const frame = fieldLife(flocks({ tiles }));
    expect(ducks(frame).length).toBeLessThanOrEqual(FIELD_LIFE.maxDucks);
    const reversed = fieldLife(flocks({ tiles: [...tiles].reverse() }));
    const byPlace = (list: typeof frame.agents) => list.map((d) => `${d.lng}/${d.lat}`).sort();
    expect(byPlace(reversed.agents)).toEqual(byPlace(frame.agents));
  });

  it('cross a seam with the same ducks whichever tile they stand in', () => {
    const inWest = (d: { lng: number; lat: number }, tile: TileAddress) =>
      lngLatToTile(tile, d.lng, d.lat).x < TILE_EXTENT;
    const place = (d: { lng: number; lat: number }) => `${d.lng}/${d.lat}`;
    let crossed = 0;
    // In the tropics the lattice keeps flocks clear of seams. Far north, a meter is more of a
    // cell, so look there for a western flock whose ducks stray past the seam.
    for (let x = 0; x < 4000 && !crossed; x++) {
      const west = { ...TILE, x: TILE.x + x, y: 18_000 };
      const east = { ...west, x: west.x + 1 };
      const westTile = { tile: west, geo: geometry() };
      const eastTile = { tile: east, geo: geometry() };
      const both = ducks(fieldLife(flocks({ tiles: [westTile, eastTile] })));
      if (both.length >= FIELD_LIFE.maxDucks) continue;
      const alone = ducks(fieldLife(flocks({ tiles: [westTile] })));
      const eastAlone = ducks(fieldLife(flocks({ tiles: [eastTile] })));
      // A duck is drawn once, by the tile it stands in, and never past the tiles at hand.
      expect(new Set(both.map(place)).size).toBe(both.length);
      for (const duck of alone) expect(inWest(duck, west)).toBe(true);
      const known = new Set(both.map(place));
      for (const duck of alone) expect(known.has(place(duck))).toBe(true);
      const eastern = new Set(eastAlone.map(place));
      crossed += both.filter((d) => !inWest(d, west) && !eastern.has(place(d))).length;
    }
    expect(crossed).toBeGreaterThan(0);
  });

  it('ignore a field too small for them', () => {
    // About 0.4 ha: smaller than the 1 ha a flock needs.
    const small = geometry(square(1000, 1000, 1000 + 400, 1000 + 400));
    expect(fieldLife(flocks({ tiles: [{ tile: TILE, geo: small }] })).agents).toEqual([]);
  });
});

describe('the duck among the birds', () => {
  it('is appended, and leaves the flocks a seed already picks unchanged', () => {
    expect(BIRD_SPECIES_ORDER.at(-1)).toBe('duck');
    expect(BIRD_SPECIES_ORDER.indexOf('bat')).toBe(4);
    // Pinned from before the duck: where each habitat's weights turn over to the next species.
    const across = (habitat: Habitat) =>
      Array.from({ length: 20 }, (_, i) => pickSpecies(habitat, () => i / 20));
    const pinned = (habitat: Habitat) => {
      const key = HABITAT_NAMES[habitat];
      const species = BIRD_SPECIES_ORDER.filter(
        (name) => !BIRD_SPECIES[name].nocturnal && BIRD_SPECIES[name].habitats[key] > 0,
      );
      const total = species.reduce((sum, name) => sum + BIRD_SPECIES[name].habitats[key], 0);
      return Array.from({ length: 20 }, (_, i) => {
        let left = (i / 20) * total;
        for (const name of species) {
          left -= BIRD_SPECIES[name].habitats[key];
          if (left < 0) return name;
        }
        return species.at(-1)!;
      });
    };
    for (const habitat of Object.values(Habitat)) {
      expect(across(habitat)).toEqual(pinned(habitat));
      expect(across(habitat)).not.toContain('duck');
    }
    for (const habitat of HABITAT_NAMES) expect(BIRD_SPECIES.duck.habitats[habitat]).toBe(0);
  });
});

describe('straw smoke', () => {
  /** A tile in which some lattice point qualifies for a pile. */
  const withPile = () => {
    for (let x = 0; x < 200; x++) {
      const tile = { ...TILE, x: TILE.x + x };
      const frame = fieldLife(input({ harvest: SMOKE, tiles: [{ tile, geo: geometry() }] }));
      if (frame.puffs.length) return { tile, frame };
    }
    throw new Error('no pile in 200 tiles');
  };

  it('rises from one ember, blown downwind about 40 m, in 16 particles at most', () => {
    const { tile, frame } = withPile();
    const count = frame.puffs.length / PUFF_STRIDE;
    expect(count).toBe(FIELD_LIFE.smokeParticles);
    const embers = named(EMBER_LABEL, frame);
    expect(embers).toHaveLength(1);
    expect(describeAgent(embers[0]!)).toBe('Burning straw (simulated)');
    const origin = lngLatToTile(tile, embers[0]!.lng, embers[0]!.lat);
    const perUnit = metersPerUnit(tile);
    for (let i = 0; i < frame.puffs.length; i += PUFF_STRIDE) {
      expect(frame.puffs[i]).toBe(-1);
      const p = lngLatToTile(tile, frame.puffs[i + 1]!, frame.puffs[i + 2]!);
      const age = frame.puffs[i + 3]!;
      expect((p.x - origin.x) * perUnit).toBeCloseTo(age * FIELD_LIFE.smokeLength, 0);
      expect(age).toBeGreaterThanOrEqual(0);
      expect(age).toBeLessThan(1);
      expect(frame.puffs[i + 4]).toBe(1);
    }
  });

  it('shows only while burning, and goes where the wind goes', () => {
    const { tile } = withPile();
    const tiles = [{ tile, geo: geometry() }];
    expect(fieldLife(input({ tiles, harvest: { ...SMOKE, burning: false } })).puffs).toEqual([]);
    const south = fieldLife(input({ tiles, harvest: SMOKE, wind: [0, 1] }));
    const ember = named(EMBER_LABEL, south)[0]!;
    expect(lngLatToTile(tile, south.puffs[1]!, south.puffs[2]!).y).toBeGreaterThan(
      lngLatToTile(tile, ember.lng, ember.lat).y,
    );
  });

  it('caps a city at 48 particles', () => {
    const tiles = Array.from({ length: 200 }, (_, x) => ({
      tile: { ...TILE, x: TILE.x + x },
      geo: geometry(),
    }));
    const { puffs } = fieldLife(input({ tiles, harvest: SMOKE }));
    expect(puffs.length / PUFF_STRIDE).toBe(FIELD_LIFE.maxSmoke);
  });
});

it('adds nothing without an active stage', () => {
  const none: HarvestNow = { drying: 0, spread: false, tractors: 0, ducks: 0, burning: false };
  expect(fieldLife(onStrips({ harvest: none }))).toEqual({ agents: [], puffs: [] });
});

describe('owner -1 puffs', () => {
  const grid: LifeGrid = {
    cols: 40,
    rows: 20,
    cellWidth: 5,
    cellHeight: 9,
    toCell: (x, y) => [x, y],
  };
  const glyphs = mapGlyphs(themes.dark);
  const index = (glyph: string) => glyphs.indexOf(glyph) + 1;
  const pack = (puffs: number[]) => {
    const out = new Uint8Array(grid.cols * grid.rows * 4);
    const stamped = { ...grid, stampedVehicles: new Uint8Array(4) };
    packLife(
      out,
      stamped,
      [],
      themes.dark,
      index,
      undefined,
      undefined,
      undefined,
      Float64Array.from(puffs),
    );
    return out;
  };
  it('draw with no stamped vehicle, as an exhaust puff of a real owner does not', () => {
    const at = (10 * grid.cols + 5) * 4;
    expect(pack([-1, 5, 10, 0.2, 1])[at + 3]).not.toBe(0);
    expect(pack([0, 5, 10, 0.2, 1])[at + 3]).toBe(0);
  });
});

describe('LifeWorld with a harvest', () => {
  /** A farm tile with a flock and a pile, found along the lattice. */
  const farmTile = () => {
    for (let x = 0; x < 400; x++) {
      const tile = { ...TILE, x: TILE.x + x };
      const frame = fieldLife(
        input({ harvest: { ...DUCKS, burning: true }, tiles: [{ tile, geo: geometry() }] }),
      );
      if (frame.puffs.length && ducks(frame).length) return tile;
    }
    throw new Error('no farm tile');
  };
  const world = (tile: TileAddress) => {
    const b = new LifeBuilder();
    b.field('f', 'farmland', WHOLE);
    const w = new LifeWorld();
    w.sync([{ key: 'f', tile, life: b.finish() }]);
    return w;
  };
  const levels = { ...activityLevels(1), harvest: { ...DUCKS, burning: true } };
  const center = (tile: TileAddress): [number, number] => {
    const { x, z } = tile;
    return [((x + 0.5) / 2 ** z) * 360 - 180, 13.6];
  };
  const weather = { rain: 0, sunAltitude: 20, field: { time: 100, wind: [1, 0] as const } };

  it('admits its actors last and drops them first at the cap', () => {
    const tile = farmTile();
    const w = world(tile);
    const all = w.visible(19, levels, center(tile), weather);
    expect(all.some((a: VisibleAgent) => a.bird?.species === 'duck')).toBe(true);
    const capped = w.visible(19, levels, center(tile), weather, undefined, 1, 3);
    expect(capped.length).toBeLessThanOrEqual(3);
  });

  it('adds nothing without the field time, a harvest, or below the people band', () => {
    const tile = farmTile();
    const w = world(tile);
    const ours = (list: VisibleAgent[]) =>
      list.filter((a) => a.fieldLabel || a.bird?.species === 'duck');
    expect(ours(w.visible(19, levels, center(tile)))).toEqual([]);
    expect(ours(w.visible(19, activityLevels(1), center(tile), weather))).toEqual([]);
    expect(ours(w.visible(16, levels, center(tile), weather))).toEqual([]);
  });

  it('appends smoke to the puff packet without taking from the exhaust', () => {
    const tile = farmTile();
    const w = world(tile);
    w.visible(19, activityLevels(1), center(tile), weather);
    const exhaust = w.visiblePuffs.length;
    w.visible(19, levels, center(tile), weather);
    expect(w.visiblePuffs.length).toBe(exhaust + FIELD_LIFE.smokeParticles * PUFF_STRIDE);
    expect(w.visiblePuffs[exhaust]).toBe(-1);
  });
});

describe('hand tractors', () => {
  const ranks = Array.from({ length: 400 }, (_, i) => i / 400);

  it('take a stable half of the carabao owners while the stage calls for them', () => {
    const on = ranks.filter((rank) => workAnimal(rank, 2, 0.5).vehicle === 'hand-tractor');
    expect(on.length / ranks.length).toBeGreaterThan(0.4);
    expect(on.length / ranks.length).toBeLessThan(0.6);
    expect(ranks.filter((rank) => workAnimal(rank, 2, 0.5).vehicle === 'hand-tractor')).toEqual(on);
  });

  it('leave a farmer with the same carabao, in its paint, once the stage ends', () => {
    for (const rank of ranks) {
      expect(workAnimal(rank, 2, 0)).toEqual({ vehicle: 'carabao', paint: 2 });
      const during = workAnimal(rank, 2, 0.5);
      if (during.vehicle === 'hand-tractor')
        expect(VEHICLES['hand-tractor'].paints).toContain(during.paint);
      else expect(during.paint).toBe(2);
    }
  });

  it('come after the earlier crafts, which keep their order, and carry a close-up plan', () => {
    const crafts = Object.keys(VEHICLES);
    expect(crafts.at(-1)).toBe('hand-tractor');
    expect(crafts.indexOf('carabao')).toBeLessThan(crafts.indexOf('ambulance'));
    expect(VEHICLES['hand-tractor'].fine?.length).toBeGreaterThan(0);
    expect(VEHICLES['hand-tractor'].length).toBe(2.6);
    expect(VEHICLES['hand-tractor'].width).toBe(1);
    expect(VEHICLES.carabao.paints).toHaveLength(3);
  });
});
