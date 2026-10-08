import { describe, expect, it, vi } from 'vitest';
import { lngLatToTile, insidePolygon } from '../raster/geometry';
import { FolkloreObserver, folkloreNight, ghostCount, type FolkloreBody } from './folklore';
import { LifeWorld } from './simulate';
import { continuityMover } from './testing/continuity';
import { packFootprints, unpackFootprints } from './geometry';
import { FolkloreGeometry, segmentInside, distance } from './folklore-geometry';
import {
  calendar,
  folkloreConfig,
  folkloreTile,
  folkloreCenter,
  rectangle,
} from './testing/folklore';

describe('folklore calendar', () => {
  it('mixes nightly chance across the eligible month instead of clustering adjacent date hashes', () => {
    const config = {
      ...folkloreConfig,
      manananggal: { ...folkloreConfig.manananggal, night_chance: 0.35 },
    };
    const nights = Array.from(
      { length: 30 },
      (_, i) => folkloreNight(config, calendar(11, i + 1), 1320)!.manananggal,
    );
    expect(nights).toContain(true);
    expect(nights).toContain(false);
    expect(nights).toEqual(
      Array.from(
        { length: 30 },
        (_, i) => folkloreNight(config, calendar(11, i + 1), 1320)!.manananggal,
      ),
    );
  });
  it('uses one night through midnight and the half-open closing boundary', () => {
    expect(folkloreNight(folkloreConfig, calendar(), 1319)).toBeUndefined();
    expect(folkloreNight(folkloreConfig, calendar(), 240)).toBeUndefined();
    expect(folkloreNight(folkloreConfig, calendar(), 241)).toBeUndefined();
    const a = folkloreNight(folkloreConfig, calendar(11, 2), 1439)!,
      b = folkloreNight(folkloreConfig, calendar(11, 3), 0)!;
    expect(a.day).toBe(b.day);
    expect(a.undas).toBe(true);
    expect(b.undas).toBe(true);
    expect(
      ghostCount(folkloreConfig, { id: 'cemetery', kind: 'cemetery' }, a),
    ).toBeGreaterThanOrEqual(3);
    expect(ghostCount(folkloreConfig, { id: 'cemetery', kind: 'cemetery' }, a)).toBe(
      ghostCount(folkloreConfig, { id: 'cemetery', kind: 'cemetery' }, b),
    );
    expect(folkloreNight(folkloreConfig, calendar(10, 31), 239)?.manananggal).toBe(false);
    expect(folkloreNight(folkloreConfig, calendar(12, 1), 239)?.manananggal).toBe(true);
    expect(folkloreNight(folkloreConfig, calendar(12, 1), 1320)?.manananggal).toBe(false);
  });
  it('accepts only the referenced preview and applies site share deterministically', () => {
    const night = (preview?: string) =>
      folkloreNight(folkloreConfig, { ...calendar(), preview }, 1320)!;
    expect(night('all-saints').manananggal).toBe(true);
    for (const id of ['christmas', 'unknown']) {
      expect(night(id).manananggal).toBe(false);
      expect(night(id).undas).toBe(false);
    }
    const c = { ...folkloreConfig, ghosts: { ...folkloreConfig.ghosts, site_share: 0 } };
    expect(ghostCount(c, { id: 'hospital', kind: 'hospital' }, night())).toBe(0);
    expect(ghostCount(folkloreConfig, { id: 'church', kind: 'worship' }, night())).toBe(1);
  });
});
describe('ghost observer', () => {
  it('wisps a tapped ghost from its captured pose and retains banishment through empty/changing tiles', () => {
    const tile = folkloreTile(),
      observer = new FolkloreObserver();
    observer.setConfig(folkloreConfig);
    for (const clock of [0, 6])
      observer.step([tile], { minutes: 1320, calendar: calendar(), clock, dt: 0 });
    const ghost = observer.packet(19, folkloreCenter).sprites.find((s) => s.kind === 'ghost')!;
    expect(observer.tap(ghost.id, 6)).toBe(true);
    observer.step([{ ...tile, geo: { ...tile.geo } }], {
      minutes: 1320,
      calendar: calendar(),
      clock: 6.4,
      dt: 0.4,
    });
    const wisp = observer.packet(19, folkloreCenter).sprites.find((s) => s.id === ghost.id)!;
    expect(wisp).toMatchObject({ lng: ghost.lng, lat: ghost.lat, pose: 'wisp' });
    expect(wisp.wisp).toBeCloseTo(0.5);
    observer.step([], { minutes: 1320, calendar: calendar(), clock: 7, dt: 0.6 });
    observer.step([tile], { minutes: 1320, calendar: calendar(), clock: 8, dt: 1 });
    expect(observer.packet(19, folkloreCenter).sprites.some((s) => s.id === ghost.id)).toBe(false);
    for (const clock of [9, 15])
      observer.step([tile], { minutes: 1320, calendar: calendar(7, 2), clock, dt: 1 });
    expect(observer.packet(19, folkloreCenter).sprites.some((s) => s.kind === 'ghost')).toBe(true);
  });
  it('returns a tapped manananggal continuously and suppresses selection until the next night', () => {
    const tile = folkloreTile(),
      observer = new FolkloreObserver();
    observer.setConfig(folkloreConfig);
    for (const clock of [0, 6])
      observer.step([tile], { minutes: 1320, calendar: calendar(11), clock, dt: 0 });
    const creature = observer.manananggal!;
    expect(observer.tap(creature.id, 6)).toBe(true);
    observer.step([tile], { minutes: 1320, calendar: calendar(11), clock: 6, dt: 0 });
    expect(observer.manananggal).toEqual(creature);
    observer.step([], { minutes: 1320, calendar: calendar(11), clock: 7, dt: 1 });
    observer.step([{ ...tile, geo: { ...tile.geo } }], {
      minutes: 1320,
      calendar: calendar(11),
      clock: 8.1,
      dt: 1.1,
    });
    expect(observer.manananggal).toBeUndefined();
    for (const clock of [9, 15])
      observer.step([tile], { minutes: 1320, calendar: calendar(11, 2), clock, dt: 1 });
    expect(observer.manananggal).toBeDefined();
  });
  it('releases previous-night sources during daytime pans and rebuilds current sites next night', () => {
    const t = folkloreTile(),
      observer = new FolkloreObserver(),
      internals = observer as unknown as { geometry?: FolkloreGeometry };
    observer.setConfig(folkloreConfig);
    observer.step([t], { minutes: 1320, calendar: calendar(), clock: 0, dt: 0 });
    expect(internals.geometry?.sources[0]?.key).toBe(t.key);
    const next = {
      ...t,
      key: 'replacement',
      geo: {
        ...t.geo,
        places: new Float32Array(),
        cemeteryAreas: [],
        hospitals: [{ id: 'new-site', x: 2700, y: 2600, radius: 0 }],
      },
    };
    observer.step([next], { minutes: 720, calendar: calendar(), clock: 10, dt: 0 });
    expect(internals.geometry).toBeUndefined();
    expect(observer.packet(18, folkloreCenter).sprites).toEqual([]);
    for (const clock of [20, 26])
      observer.step([next], { minutes: 1320, calendar: calendar(), clock, dt: 1 });
    expect(internals.geometry?.sources[0]?.key).toBe('replacement');
    expect(observer.packet(18, folkloreCenter).sprites.map((s) => s.id)).toEqual([
      expect.stringContaining('/hospital/new-site/'),
    ]);
  });

  it('skips observations on ghost-free and manananggal-only nights', () => {
    const t = folkloreTile(),
      observer = new FolkloreObserver(),
      bodies = vi.fn(() => []);
    observer.setConfig({
      ...folkloreConfig,
      ghosts: { ...folkloreConfig.ghosts, sites: ['worship', 'hospital'], site_share: 0 },
    });
    for (const month of [7, 11])
      for (const clock of [0, 6])
        observer.step([t], { minutes: 1320, calendar: calendar(month), clock, dt: 1 }, bodies);
    expect(bodies).not.toHaveBeenCalled();
    expect(observer.packet(16, folkloreCenter).sprites.map((s) => s.kind)).toEqual([
      'manananggal',
      'lower-half',
    ]);
  });

  it('observes body overlap on the first admitted ghost step', () => {
    const t = folkloreTile(),
      observer = new FolkloreObserver();
    observer.setConfig({
      ...folkloreConfig,
      ghosts: { ...folkloreConfig.ghosts, sites: ['hospital'] },
    });
    const bodies = vi.fn((g: FolkloreGeometry, points: readonly { x: number; y: number }[]) => {
      expect(points).toHaveLength(1);
      return [
        {
          ...g.world(t, { x: 2700, y: 2600 }),
          hx: 1,
          hy: 0,
          length: 100,
          width: 100,
          walker: true,
        },
      ];
    });
    observer.step([t], { minutes: 1320, calendar: calendar(), clock: 0, dt: 0 }, bodies);
    expect(bodies).toHaveBeenCalledOnce();
    const ghosts = (
      observer as unknown as { ghosts: Map<string, { overlap: boolean; wispAt: number }> }
    ).ghosts;
    expect([...ghosts.values()]).toEqual([expect.objectContaining({ overlap: true, wispAt: 0 })]);
  });

  it('filters distant posed bodies without excluding displaced or rotated vehicle edges', () => {
    const t = folkloreTile(),
      world = new LifeWorld();
    world.setFolklore(folkloreConfig);
    world.sync([{ key: t.key, tile: t.tile, life: t.geo }]);
    const life = world.resident(t.key)!,
      g = new FolkloreGeometry([t], t),
      ghost = g.world(t, { x: 2700, y: 2600 }),
      near = continuityMover(life, 1000, 'vehicle'),
      far = continuityMover(life, 1200, 'vehicle');
    near.vehicle = far.vehicle = 'bus';
    life.movers.length = 0;
    life.movers.push(near, far);
    vi.spyOn(life, 'pose').mockImplementation((m, out = { x: 0, y: 0, hx: 0, hy: 0 }) => {
      const shift = m === near ? 4 : 200;
      Object.assign(out, {
        x: 2700 + shift * life.perMeter,
        y: 2600 + shift * life.perMeter,
        hx: Math.SQRT1_2,
        hy: Math.SQRT1_2,
      });
      return out;
    });
    const observer = (world as unknown as { folklore: FolkloreObserver }).folklore;
    let observed: readonly FolkloreBody[] = [];
    vi.spyOn(observer, 'step').mockImplementation((_tiles, _env, bodies) => {
      observed = bodies!(g, [ghost]);
    });
    (world as unknown as { sampleFolklore(weather: undefined, dt: number): void }).sampleFolklore(
      undefined,
      0,
    );
    expect(observed).toHaveLength(1);
    expect(observed[0]!.x).toBeCloseTo(ghost.x + 4, 6);
    expect(observed[0]!.y).toBeCloseTo(ghost.y + 4, 6);
    const body = observed[0]!,
      dx = ghost.x - body.x,
      dy = ghost.y - body.y;
    expect(Math.abs(dx * body.hx + dy * body.hy)).toBeLessThan(body.length / 2 + 0.35);
    expect(Math.abs(-dx * body.hy + dy * body.hx)).toBeLessThan(body.width / 2 + 0.35);
  });

  it('observes only drawn movers under crowd reduction and scene hiding', () => {
    const t = folkloreTile(),
      world = new LifeWorld();
    world.setFolklore(folkloreConfig);
    world.sync([{ key: t.key, tile: t.tile, life: t.geo }]);
    const life = world.resident(t.key)!,
      geometry = new FolkloreGeometry([t], t),
      ghost = geometry.world(t, { x: 2700, y: 2600 }),
      shown = continuityMover(life, 1000, 'person'),
      reduced = continuityMover(life, 1100, 'person'),
      hidden = continuityMover(life, 1200, 'person');
    shown.rank = hidden.rank = 0;
    reduced.rank = 0.5;
    life.movers.length = 0;
    life.movers.push(shown, reduced, hidden);
    vi.spyOn(life.scenes, 'hidden').mockImplementation((m) => m === hidden);
    vi.spyOn(life, 'pose').mockImplementation((_m, out = { x: 0, y: 0, hx: 1, hy: 0 }) => {
      Object.assign(out, { x: 2700, y: 2600 });
      return out;
    });
    const observer = (world as unknown as { folklore: FolkloreObserver }).folklore;
    let observed: readonly FolkloreBody[] = [];
    vi.spyOn(observer, 'step').mockImplementation((_tiles, _env, bodies) => {
      observed = bodies!(geometry, [ghost]);
    });
    const sample = () =>
      (world as unknown as { sampleFolklore(weather: undefined, dt: number): void }).sampleFolklore(
        undefined,
        0,
      );
    world.visible(18, 1, folkloreCenter, undefined, undefined, 0.3);
    sample();
    expect(observed).toHaveLength(1);
    world.visible(18, 1, folkloreCenter, undefined, undefined, 1);
    sample();
    expect(observed).toHaveLength(2);
  });

  it('does no roof-neighborhood distance work without fields, even on a dense tile', () => {
    const t = folkloreTile();
    t.geo = {
      ...t.geo,
      fields: undefined,
      hospitals: [],
      cemeteryAreas: [],
      places: new Float32Array(),
      roofs: packFootprints(
        Array.from({ length: 1600 }, (_, i) => {
          const x = 20 + (i % 40) * 90,
            y = 20 + Math.floor(i / 40) * 90;
          return {
            id: `roof/${i}`,
            rings: [rectangle(x, y, 30)],
            anchor: { x: x + 15, y: y + 15 },
          };
        }),
      ),
    };
    const hypot = vi.spyOn(Math, 'hypot');
    try {
      const g = new FolkloreGeometry([t], t);
      expect(g.roofs).toHaveLength(1600);
      expect(g.candidates).toEqual([]);
      expect(hypot).not.toHaveBeenCalled();
    } finally {
      hypot.mockRestore();
    }
  });

  it('requires distinct owned roof identities and keeps nearest-center identity ties stable', () => {
    const t = folkloreTile(),
      roof = unpackFootprints(t.geo.roofs)[0]!;
    const geometry = (ids: string[]) => {
      const geo = { ...t.geo, roofs: packFootprints(ids.map((id) => ({ ...roof, id }))) };
      return new FolkloreGeometry([{ ...t, geo }], t);
    };
    expect(geometry(['a', 'a', 'b']).candidates).toEqual([]);
    const g = geometry(['c', 'a', 'b']);
    expect(g.candidates).toHaveLength(1);
    expect(g.candidates[0]!.centre.id).toBe('a');
    expect(new FolkloreGeometry([{ ...t, owns: () => false }], t).candidates).toEqual([]);
    // The same immutable geo cache is reused, but ownership is evaluated for each residency.
    expect(new FolkloreGeometry([t], t).candidates).toHaveLength(1);
  });

  it('selects the same field edge after the metric reference changes', () => {
    const t = folkloreTile(),
      a = new FolkloreGeometry([t], t),
      b = new FolkloreGeometry([t], { ...t, tile: { ...t.tile, x: t.tile.x - 2 } });
    expect(a.candidates).toHaveLength(1);
    expect(b.candidates).toHaveLength(1);
    const aa = a.local(t, a.candidates[0]!.lower),
      bb = b.local(t, b.candidates[0]!.lower);
    expect(bb.x).toBeCloseTo(aa.x, 6);
    expect(bb.y).toBeCloseTo(aa.y, 6);
    expect(b.candidates[0]!.centre.id).toBe(a.candidates[0]!.centre.id);
  });

  it('turns at the configured route range and returns to the mapped attachment', () => {
    const t = folkloreTile(),
      o = new FolkloreObserver(),
      g = new FolkloreGeometry([t], t);
    o.setConfig({ ...folkloreConfig, ghosts: { ...folkloreConfig.ghosts, range_m: [30, 30] } });
    o.step([t], { minutes: 1320, calendar: calendar(), clock: 0, dt: 0 });
    // Speed is independently seeded; sample the actual turning times without physical stepping.
    const ghosts = (o as unknown as { ghosts: Map<string, { speed: number }> }).ghosts;
    for (const kind of ['worship', 'hospital'] as const) {
      const site = g.sites.find((s) => s.kind === kind)!,
        start = g.route(site)[0]!,
        id = [...ghosts.keys()].find((id) => id.includes(`/${kind}/`))!,
        turn = 30 / ghosts.get(id)!.speed;
      const at = (clock: number) => {
        o.step([t], { minutes: 1320, calendar: calendar(), clock, dt: 0 });
        const sprite = o.packet(18, folkloreCenter).sprites.find((s) => s.id === id)!;
        expect(sprite).toBeDefined();
        return g.world(t, lngLatToTile(t.tile, sprite.lng, sprite.lat));
      };
      expect(distance(start, at(turn))).toBeCloseTo(30, 5);
      expect(distance(start, at(turn * 1.5))).toBeCloseTo(15, 5);
      expect(distance(start, at(turn * 2))).toBeCloseTo(0, 5);
    }
  });
  it('animates fixed Night, remains inside solid cemetery geometry, relocates and clears on a time jump', () => {
    const t = folkloreTile(),
      a = new FolkloreObserver(),
      b = new FolkloreObserver();
    for (const o of [a, b]) o.setConfig(folkloreConfig);
    let first = '';
    for (const clock of [0, 6, 7, 35, 91, 100, 180]) {
      for (const o of [a, b]) o.step([t], { minutes: 1320, calendar: calendar(), clock, dt: 1 });
      const packet = a.packet(18, folkloreCenter);
      expect(packet).toEqual(b.packet(18, folkloreCenter));
      for (const ghost of packet.sprites.filter((s) => s.id.includes('/cemetery/'))) {
        const p = lngLatToTile(t.tile, ghost.lng, ghost.lat);
        expect(insidePolygon(t.geo.cemeteryAreas![0]!.rings, p)).toBe(true);
      }
      if (clock === 6) first = JSON.stringify(packet.sprites);
      if (clock === 7) expect(JSON.stringify(packet.sprites)).not.toBe(first);
    }
    a.step([t], { minutes: 239, calendar: calendar(7, 2), clock: 181, dt: 1 });
    expect(a.packet(18, folkloreCenter).sprites.length).toBeGreaterThan(0);
    a.step([t], { minutes: 241, calendar: calendar(7, 2), clock: 182, dt: 1 });
    expect(a.packet(18, folkloreCenter).sprites).toEqual([]);
  });
  it('fades near a walker, wisps through a body and recovers without registering owners', () => {
    const t = folkloreTile(),
      o = new FolkloreObserver();
    o.setConfig(folkloreConfig);
    const step = (clock: number, bodies = false) =>
      o.step([t], { minutes: 1320, calendar: calendar(), clock, dt: 1 }, (g) => {
        return bodies
          ? [
              {
                ...g.world(t, { x: 2700, y: 2600 }),
                hx: 1,
                hy: 0,
                length: 100,
                width: 100,
                walker: true,
              },
            ]
          : [];
      });
    step(0);
    step(6, true);
    const s = o.packet(18, folkloreCenter).sprites.find((s) => s.id.includes('/hospital/'))!;
    expect(s.alpha).toBeCloseTo(0.15);
    expect(s.pose).toBe('wisp');
    step(7);
    expect(o.packet(18, folkloreCenter).sprites.find((v) => v.id === s.id)?.alpha).toBeGreaterThan(
      0.15,
    );
    step(9);
    expect(
      o.packet(18, folkloreCenter).sprites.find((s) => s.id.includes('/hospital/'))?.pose,
    ).toBe('breath');
  });
  it('deduplicates buffered markerless cemetery fragments and validates holes and concave segments', () => {
    const t = folkloreTile();
    t.geo.cemeteryAreas![0]!.hasBurials = false;
    const duplicate = { ...t, key: 'buffer', owns: () => false };
    const g = new FolkloreGeometry([t, duplicate], t);
    expect(g.sites.filter((s) => s.kind === 'cemetery')).toHaveLength(1);
    const rings = [rectangle(0, 0, 100), rectangle(40, 40, 20)];
    expect(segmentInside(rings, { x: 20, y: 50 }, { x: 80, y: 50 })).toBe(false);
    const concave = [
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
        { x: 70, y: 100 },
        { x: 70, y: 30 },
        { x: 30, y: 30 },
        { x: 30, y: 100 },
        { x: 0, y: 100 },
        { x: 0, y: 0 },
      ],
    ];
    expect(segmentInside(concave, { x: 10, y: 80 }, { x: 90, y: 80 })).toBe(false);
    const hospital = g.sites.find((s) => s.kind === 'hospital')!,
      route = g.route(hospital);
    expect(distance(route[0]!, route.at(-1)!)).toBeGreaterThan(50);
    const roads = structuredClone(t.geo);
    roads.kinds[0] = 0;
    expect(new FolkloreGeometry([{ ...t, geo: roads }], t).route(hospital)).toEqual(route);
  });
});
