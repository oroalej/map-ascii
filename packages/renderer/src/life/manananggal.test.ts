import { expect, it } from 'vitest';
import { FolkloreObserver } from './folklore';
import { FolkloreGeometry, distance } from './folklore-geometry';
import { manananggalPose, manananggalTiming } from './manananggal';
import { calendar, folkloreConfig, folkloreTile, folkloreCenter } from './testing/folklore';
import { parent, right, continuityMover } from './testing/continuity';
import { frameBetween } from './frames';
import { lngLatToTile, tileToLngLat } from '../raster/geometry';
import { LifeWorld, TileLife, type LifeEnv, type Flock } from './simulate';
import { LifeBuilder, packFootprints, unpackFootprints } from './geometry';
import { Habitat } from './birds';
import { FOLKLORE } from './folklore-config';

it('varies nightly fields and cycle landings across neighboring dates and sequential identities', () => {
  const t = folkloreTile(),
    field = unpackFootprints(t.geo.fields)[0]!,
    roof = unpackFootprints(t.geo.roofs)[0]!;
  t.geo.fields = packFootprints(
    Array.from({ length: 12 }, (_, i) => ({ ...field, id: `way/${100000000 + i}` })),
  );
  t.geo.roofs = packFootprints(
    Array.from({ length: 40 }, (_, i) => ({ ...roof, id: `way/${200000000 + i}` })),
  );
  const observer = new FolkloreObserver(),
    geometry = new FolkloreGeometry([t], t),
    internals = observer as unknown as {
      selection: { candidate: { id: string } };
      landing(
        g: FolkloreGeometry,
        c: (typeof geometry.candidates)[number],
        night: number,
        cycle: number,
      ): { id: string };
    },
    fields = new Set<string>(),
    landings = new Set<string>();
  observer.setConfig(folkloreConfig);
  for (let i = 0; i < 30; i++) {
    observer.step([t], { minutes: 1320, calendar: calendar(11, i + 1), clock: 0, dt: 0 });
    fields.add(internals.selection.candidate.id);
    const landing = internals.landing(geometry, geometry.candidates[0]!, calendar(11).epochDay, i);
    landings.add(landing.id);
    expect(internals.landing(geometry, geometry.candidates[0]!, calendar(11).epochDay, i)).toEqual(
      landing,
    );
  }
  expect(fields.size).toBeGreaterThanOrEqual(8);
  expect(landings.size).toBeGreaterThanOrEqual(15);
});

it('flies, approaches a solid roof continuously, lands and returns by the civil boundary', () => {
  const t = folkloreTile(),
    g = new FolkloreGeometry([t], t),
    c = g.candidates[0]!,
    roof = g.roofs[1]!,
    night = calendar(11).epochDay;
  expect(c).toBeDefined();
  expect(distance(c.lower, c.centre.at)).toBeLessThanOrEqual(300);
  const timing = manananggalTiming(c, night);
  expect(timing.flight).toBeGreaterThanOrEqual(180);
  expect(timing.flight).toBeLessThanOrEqual(360);
  const at = (elapsed: number, remaining = 360) =>
    manananggalPose(c, roof, night, elapsed, remaining);
  expect(distance(at(timing.flight - 0.001).at, at(timing.flight).at)).toBeLessThan(0.01);
  expect(at(timing.flight + 1).at).toEqual(roof.at);
  expect(at(timing.flight + 1).pose).toBe('perched');
  const depart = timing.flight + timing.landing;
  for (const elapsed of [
    FOLKLORE.departure / 2,
    timing.flight - FOLKLORE.approach / 2,
    depart + FOLKLORE.departure / 2,
  ]) {
    const current = at(elapsed),
      next = at(elapsed + 0.1),
      dx = next.at.x - current.at.x,
      dy = next.at.y - current.at.y;
    expect(Math.cos(current.heading) * dx + Math.sin(current.heading) * dy).toBeCloseTo(
      Math.hypot(dx, dy),
      8,
    );
  }
  expect(distance(at(depart - 0.001).at, at(depart + 0.001).at)).toBeLessThan(0.01);
  expect(at(12).at).not.toEqual(at(13).at);
  expect(at(20, 0).at).toEqual(c.lower);
  expect(at(20, -1).returned).toBe(true);
});
it('preserves latched world anchors and elapsed pose through parent/fine ownership transfer', () => {
  const t = folkloreTile(),
    o = new FolkloreObserver();
  o.setConfig(folkloreConfig);
  const step = (tiles = [t]) =>
    o.step(tiles, { minutes: 1320, calendar: calendar(11), clock: 20, dt: 0 });
  o.step([t], { minutes: 1320, calendar: calendar(11), clock: 0, dt: 0 });
  step();
  const saved = o.packet(16, folkloreCenter);
  const f = frameBetween(t.tile, parent),
    point = (p: { x: number; y: number }) => ({ x: f.x + p.x * f.scale, y: f.y + p.y * f.scale }),
    geo = structuredClone(t.geo);
  geo.fields = packFootprints(
    unpackFootprints(geo.fields).map((s) => ({ ...s, rings: s.rings.map((r) => r.map(point)) })),
  );
  geo.roofs = packFootprints(
    unpackFootprints(geo.roofs).map((s) => ({
      ...s,
      anchor: point(s.anchor),
      rings: s.rings.map((r) => r.map(point)),
    })),
  );
  step([{ ...t, key: 'parent', tile: parent, perMeter: t.perMeter * f.scale, geo }]);
  expect(o.packet(16, folkloreCenter)).toEqual(saved);
  step([t]);
  expect(o.packet(16, folkloreCenter)).toEqual(saved);
});
it('uses the sampled world position for output-only dog facing and neighboring zero-wary flock flushing', () => {
  const t = folkloreTile(),
    world = new LifeWorld();
  world.setFolklore(folkloreConfig);
  world.sync([{ key: t.key, tile: t.tile, life: t.geo }]);
  const weather = { rain: 0, minutes: 1320, folkloreDate: calendar(11) };
  world.step(6, undefined, 18, undefined, undefined, weather);
  world.step(6, undefined, 18, undefined, undefined, weather);
  const creature = world
      .visibleFolklore(18, folkloreCenter)
      .sprites.find((s) => s.kind === 'manananggal')!,
    life = world.resident(t.key)!;
  expect(creature).toBeDefined();
  const p = lngLatToTile(t.tile, creature.lng, creature.lat),
    dog = continuityMover(life, p.x - 10 * life.perMeter, 'dog');
  dog.x = p.x - 10 * life.perMeter;
  dog.y = p.y;
  dog.pause = 10;
  life.movers.push(dog);
  const before = structuredClone(dog),
    visible = world
      .visible(18, 1, folkloreCenter)
      .find((s) => s.kind === 'dog' && Math.abs(s.lng - tileToLngLat(t.tile, dog)[0]) < 1e-6)!;
  expect(visible).toBeDefined();
  const ahead = lngLatToTile(t.tile, ...visible.ahead!);
  expect(ahead.x).toBeGreaterThan(dog.x);
  expect(dog).toEqual(before);
  const b = new LifeBuilder();
  b.roost({ x: 2000, y: 2000 }, Habitat.park);
  const neighbor = new TileLife(right, b.finish(), 19);
  const at = lngLatToTile(right, creature.lng, creature.lat),
    flock = neighbor.flocks[0]!;
  expect(flock).toBeDefined();
  Object.assign(flock, {
    ...at,
    species: 'swallow',
    perched: true,
    landed: false,
    stay: 100,
    home: -1,
    perch: -1,
  });
  const test = neighbor as unknown as {
    stepFlocks(dt: number, gust: undefined, near: undefined, env: LifeEnv): void;
    disturbed(flock: Flock, levels: undefined, point: { x: number; y: number }): boolean;
  };
  expect(test.disturbed(flock, undefined, at)).toBe(true);
  test.stepFlocks(0.1, undefined, undefined, { rain: 0, folkloreDisturber: creature });
  expect(flock.perched).toBe(false);
});
it('latches one selection and landing through arrivals, releases missing active coverage and handles zero chance', () => {
  const t = folkloreTile(),
    o = new FolkloreObserver();
  o.setConfig(folkloreConfig);
  const step = (clock: number, tiles = [t], date = calendar(11)) =>
    o.step(tiles, { minutes: 1320, calendar: date, clock, dt: 1 });
  step(0);
  step(6);
  const original = o.packet(16, folkloreCenter).sprites;
  expect(original).toHaveLength(2);
  expect(o.packet(16, folkloreCenter).haunts).toHaveLength(1);
  const extra = { ...t, key: 'new', geo: structuredClone(t.geo), owns: () => true };
  extra.geo.fields!.items[0]!.id = 'lower-hash-farmland';
  extra.geo.fields!.items[0]!.kind = 'farmland';
  step(6, [extra, t]);
  expect(o.packet(16, folkloreCenter).sprites).toEqual(original);
  const equivalent = { ...t, geo: structuredClone(t.geo) };
  step(6, [equivalent]);
  expect(o.packet(16, folkloreCenter).sprites).toEqual(original);
  const missing = { ...t, geo: { ...t.geo, roofs: undefined, fields: undefined } };
  step(7, [missing]);
  expect(o.packet(16, folkloreCenter).sprites).toEqual([]);
  expect(o.manananggal).toBeUndefined();
  step(8);
  step(14);
  expect(o.packet(16, folkloreCenter).sprites[0]!.id).toBe(original[0]!.id);
  step(15, [t], calendar(11, 2));
  expect(o.packet(16, folkloreCenter).sprites).toEqual([]);
  o.setConfig({
    ...folkloreConfig,
    manananggal: { ...folkloreConfig.manananggal, night_chance: 0 },
  });
  step(16);
  step(30);
  expect(o.manananggal).toBeUndefined();
});
it('selects independently of tile enumeration and releases each required anchor separately', () => {
  const t = folkloreTile(),
    extra = { ...t, key: 'another', geo: structuredClone(t.geo) };
  extra.geo.fields!.items[0]!.id = 'farmland';
  extra.geo.fields!.items[0]!.kind = 'farmland';
  const sample = (tiles: (typeof t)[]) => {
    const o = new FolkloreObserver();
    o.setConfig(folkloreConfig);
    for (const clock of [0, 6])
      o.step(tiles, { minutes: 1320, calendar: calendar(11), clock, dt: 1 });
    return o.packet(16, folkloreCenter);
  };
  const forward = sample([t, extra]);
  expect(forward.sprites).toHaveLength(2);
  expect(sample([extra, t])).toEqual(forward);
  for (const anchor of ['field', 'centre', 'landing'] as const) {
    const o = new FolkloreObserver();
    o.setConfig(folkloreConfig);
    for (const clock of [0, 6])
      o.step([t], { minutes: 1320, calendar: calendar(11), clock, dt: 1 });
    expect(o.packet(16, folkloreCenter).sprites).toHaveLength(2);
    // Read observer-only identities to remove the exact active contributor, never physical state.
    const selected = (
      o as unknown as {
        selection: { candidate: { id: string; centre: { id: string } }; landing: { id: string } };
      }
    ).selection;
    const geo = structuredClone(t.geo);
    if (anchor === 'field')
      geo.fields = packFootprints(
        unpackFootprints(geo.fields).filter((f) => f.id !== selected.candidate.id),
      );
    else {
      const id = anchor === 'centre' ? selected.candidate.centre.id : selected.landing.id;
      geo.roofs = packFootprints(unpackFootprints(geo.roofs).filter((r) => r.id !== id));
    }
    o.step([{ ...t, geo }], { minutes: 1320, calendar: calendar(11), clock: 7, dt: 1 });
    expect(o.packet(16, folkloreCenter)).toEqual({ sprites: [], haunts: [] });
    expect(o.manananggal).toBeUndefined();
  }
  const invalid = { ...t, geo: { ...t.geo, fields: undefined } };
  expect(sample([invalid]).sprites).toEqual([]);
});
