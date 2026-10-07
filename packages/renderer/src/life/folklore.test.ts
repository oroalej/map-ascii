import { describe, expect, it } from 'vitest';
import { lngLatToTile, insidePolygon } from '../raster/geometry';
import { FolkloreObserver, folkloreNight, ghostCount } from './folklore';
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
