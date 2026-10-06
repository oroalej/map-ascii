import { eventActor, identifyEventActor } from './event-actors';
import { describe, expect, it, vi } from 'vitest';
import { FrameProfiler } from '../profile';
import {
  eventOccurrence,
  processionFormationWidth,
  localMetricProjection,
  type StreetRoute,
  type MassRoute,
  type FluvialRoute,
} from '@atlas/shared';
import { GroundProcessionScene } from './procession-street';
import { LifeInspection } from './inspection';
import { liveProgress } from './procession';
import { eventGroundAllows, eventBridgeAllows, groundForRoute } from './ground-events';
import * as groundEvents from './ground-events';
import { LifeWorld, type Mover, type Stall } from './simulate';
import { LifeBuilder, LifeLine } from './geometry';
import { CellBit, EVENT_PERSON_BITS, MAX_TILE_AGENTS } from './config';
import { metersPerUnit, tileToLngLat, lngLatToTile } from '../raster/geometry';
import { worldTiles } from './testing/scenarios';
import { createInlineHost } from './host';
import { createLifeWorkerApi } from './worker-api';
import { makeCellGuard } from './cell-guard';
import { ProcessionGlyph, PROCESSION_GLYPHS } from './procession-glyphs';
import { buildLifeGlyphs, packLife } from './draw';
import { mapGlyphs, themes } from '../theme';
import { Occupancy, type Body } from './occupancy';

const tile = { z: 16, x: 55192, y: 30266 },
  pm = 1 / metersPerUnit(tile);
const point = (x: number, y = 2000) => tileToLngLat(tile, { x, y });
const routePoints = Array.from({ length: 51 }, (_, i) => point(1000 + i * 4 * pm));
const street: StreetRoute = {
  id: 'procession/street',
  kind: 'procession',
  title: { en: 'Street' },
  status: 'draft',
  route: routePoints,
  length_m: 200,
  segments: routePoints.slice(1).map(() => ({ id: 'osm:way/1', width_m: 8, sidewalk_m: 2 })),
  blocked: [],
  schedule: {
    month: 9,
    weekday: 6,
    nth: 3,
    offset_days: -8,
    start: '12:00',
    duration_min: 240,
    timezone: 'Asia/Manila',
  },
};
const mass: MassRoute = {
  id: 'procession/mass',
  kind: 'mass',
  title: { en: 'Mass' },
  status: 'draft',
  follows: street.id,
  schedule: { ...street.schedule, start: '16:00', duration_min: 90 },
  site: {
    id: 'osm:way/2',
    location: point(1000 + 100 * pm, 2000 - 20 * pm),
    anchor: point(1000 + 100 * pm, 2000 - 8 * pm),
    radius_m: 100,
    grounds: [
      [point(900, 1900), point(2200, 1900), point(2200, 2100), point(900, 2100), point(900, 1900)],
    ],
    blocked: [],
    approaches: [[point(1000), point(1000 + 100 * pm, 2000 - 8 * pm)]],
    roads: [{ line: routePoints, width_m: 8 }],
  },
};
function ordinaryPerson(x: number, y = 2000, rank = 0): Mover {
  return {
    kind: 'person',
    line: 0,
    from: 0,
    dir: 1,
    d: x,
    x,
    y,
    hx: 1,
    hy: 0,
    speed: 0,
    paint: 0,
    lane: 0,
    pause: 100,
    rank,
    group: [{ figure: 'adult', shirt: 3, umbrella: 0, canopy: 0, lateral: 0, back: 0, step: 0 }],
  };
}
function world(inspection = false, profiler?: FrameProfiler) {
  const b = new LifeBuilder();
  b.line(
    [
      { x: 0, y: 2000 },
      { x: 4096, y: 2000 },
    ],
    LifeLine.roadMinor,
    8,
    1,
    1,
  );
  const w = new LifeWorld(undefined, profiler, undefined, inspection);
  w.setProcessions([street, mass]);
  w.sync([{ key: 'road', tile, life: b.finish() }]);
  const life = worldTiles(w).get('road')!;
  life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
  life.scenes.sites.length = 0;
  return { w, life };
}
describe('street event simulation', () => {
  it('rejects narrow roofs crossing complete footprints even when every sample is outside', () => {
    const corners = [point(1000, 2000), point(1010, 2000), point(1010, 2010), point(1000, 2010)];
    const roof = [
      point(1003, 1995),
      point(1004, 1995),
      point(1004, 2015),
      point(1003, 2015),
      point(1003, 1995),
    ];
    const ground = { regions: [mass.site.grounds[0]!], blocked: [roof] };
    expect(eventGroundAllows(ground, corners)).toBe(true);
    expect(eventGroundAllows(ground, corners, corners)).toBe(false);
    const guard = makeCellGuard(
      { tile, perMeter: pm },
      { roads: { hits: () => false }, forbidden: { hits: () => false } },
      { hits: () => false },
      (lng, lat) => {
        const at = lngLatToTile(tile, lng, lat);
        return [at.x / 10, at.y / 10];
      },
      new Map([['test', ground]]),
    );
    expect(guard({ kind: 'person', lng: 0, lat: 0, flap: 0, eventGround: 'test' }, 100, 200)).toBe(
      false,
    );
  });
  it('keeps actor identities in simulation without transferring them in worker frames', () => {
    const { w, life } = world(true);
    const api = createLifeWorkerApi(undefined, () => w);
    api.init({ processions: [street, mass], itemInspection: true });
    api.sync([{ key: 'road', tile, life: life.geo }]);
    api.setLive(street.id, 0.5);
    const center = point(1000 + 100 * pm);
    const result = api.frame({
      gust: {
        camera: { lng: center[0], lat: center[1], zoom: 18 },
        size: { width: 800, height: 600 },
        cssCell: { w: 5, h: 7.5 },
        time: 0,
        wind: { dir: [1, 0], strength: 0 },
      },
      step: {
        dt: 0.1,
        zoom: 18,
        bounds: undefined,
        wind: undefined,
        weather: undefined,
        cellMeters: 0,
      },
      visible: [18, 1, center],
    });
    const actors = result.agents.filter((a) => a.eventGround);
    expect(actors.length).toBeGreaterThan(0);
    expect(actors.every((a) => eventActor(a) && !Object.hasOwn(a, 'eventActor'))).toBe(true);
    expect(
      structuredClone(actors).every((a) => !eventActor(a) && !Object.hasOwn(a, 'eventActor')),
    ).toBe(true);
    w.step(0.1, () => 0, 18);
    expect(w.visible(18, 1, center).some((a) => eventActor(a))).toBe(true);
  });
  it('caches cell permissions separately for each ground and cell', () => {
    const permission = vi.spyOn(groundEvents, 'eventGroundAllows');
    try {
      const ground = groundForRoute(street);
      const denied = { regions: ground.regions, blocked: ground.regions };
      const toCell = (lng: number, lat: number): [number, number] => {
        const q = lngLatToTile(tile, lng, lat);
        return [q.x / pm, q.y / pm];
      };
      const empty = { hits: () => false };
      const guard = makeCellGuard(
        { tile, perMeter: pm },
        { roads: empty, forbidden: empty },
        empty,
        toCell,
        new Map([
          ['allowed', ground],
          ['denied', denied],
        ]),
      );
      const agent = {
        kind: 'person' as const,
        lng: point(1500)[0],
        lat: point(1500)[1],
        flap: 0,
        eventGround: 'allowed',
      };
      const col = Math.floor(1500 / pm),
        row = Math.floor(2000 / pm);
      for (let i = 0; i < 20; i++) expect(guard(agent, col, row)).toBe(true);
      expect(permission).toHaveBeenCalledTimes(1);
      expect(guard({ ...agent, eventGround: 'denied' }, col, row)).toBe(false);
      expect(guard({ ...agent, eventGround: 'denied' }, col, row)).toBe(false);
      expect(permission).toHaveBeenCalledTimes(2);
      expect(guard(agent, col + 1, row)).toBe(true);
      expect(permission).toHaveBeenCalledTimes(3);
    } finally {
      permission.mockRestore();
    }
  });
  it.each([
    [179.999, 89.999],
    [-179.999, -89.999],
    [0.00025, -16.384],
  ] as const)('indexes geographic permissions without local-bin aliases at %j', (x, y) => {
    const ground = {
      regions: [
        [
          [x - 0.00001, y - 0.00001],
          [x + 0.00001, y - 0.00001],
          [x + 0.00001, y + 0.00001],
          [x - 0.00001, y + 0.00001],
          [x - 0.00001, y - 0.00001],
        ] as [number, number][],
      ],
      blocked: [],
    };
    expect(eventGroundAllows(ground, [[x, y]])).toBe(true);
    expect(eventGroundAllows(ground, [[0, 0]])).toBe(false);
  });
  it('builds both initial occupancies in one steady-event pass', () => {
    const profiler = new FrameProfiler();
    const builds = vi.spyOn(profiler, 'add');
    const { w, life } = world(false, profiler);
    life.movers.push(ordinaryPerson(3000));
    w.setLive(street.id, 0.6, 'test');
    w.step(0.1, undefined, 18);
    builds.mockClear();
    w.step(0.1, undefined, 18);
    expect(builds.mock.calls.filter(([stage]) => stage === 'clearanceBuild')).toHaveLength(1);
  });
  it.each(['car', 'attendant'] as const)(
    'checks off-view %s bodies during admission independently of camera bounds',
    (obstacle) => {
      for (const bounds of [undefined, [20, 10, 21, 11] as [number, number, number, number]]) {
        const { w, life } = world();
        const candidate = new GroundProcessionScene(street)
          .agents(0.6, 0, { scope: 'live/test' })
          .find((actor) => !actor.prop)!;
        const at = lngLatToTile(tile, candidate.lng, candidate.lat);
        if (obstacle === 'car')
          life.movers.push({
            kind: 'vehicle',
            vehicle: 'car',
            ...at,
            y: 2000,
            hx: 1,
            hy: 0,
            line: 0,
            from: 0,
            dir: 1,
            d: at.x,
            speed: 0,
            v: 0,
            paint: 0,
            lane: 0,
            pause: 100,
            rank: 99,
          });
        else {
          const stall: Stall = {
            x: at.x + 1.3 * pm,
            y: at.y,
            hx: 0,
            hy: 1,
            side: 1,
            rank: 99,
            paint: 0,
            shirt: 0,
          };
          life.stalls.push(stall);
        }
        w.visible(18, 0.01, point(1500), undefined, bounds);
        w.setLive(street.id, 0.6, 'test');
        w.step(0.1, undefined, 18, bounds);
        const admitted = w.visible(18, 1, point(1500)).filter((actor) => eventActor(actor));
        expect(admitted.length).toBeGreaterThan(0);
        expect(admitted.some((actor) => eventActor(actor) === eventActor(candidate))).toBe(
          obstacle === 'car',
        );
      }
    },
  );
  it('invalidates cached reservations when the loaded reference tile changes and restores stable identities', () => {
    const { w, life } = world();
    w.setLive(street.id, 0.6, 'test');
    w.step(0.1, undefined, 18);
    const ids = w
      .visible(18, 1, point(1500))
      .filter((actor) => eventActor(actor))
      .map((actor) => eventActor(actor));
    const neighbor = {
      key: 'neighbor',
      tile: { ...tile, x: tile.x + 1 },
      life: new LifeBuilder().finish(),
    };
    w.sync([neighbor]);
    expect(w.visible(18, 1, point(1500)).filter((actor) => eventActor(actor))).toEqual([]);
    w.sync([neighbor, { key: 'road', tile, life: life.geo }]);
    w.step(0.1, undefined, 18);
    expect(
      w
        .visible(18, 1, point(1500))
        .filter((actor) => eventActor(actor))
        .map((actor) => eventActor(actor)),
    ).toEqual(ids);
    w.stop();
    w.setLive(undefined);
    expect(life.eventPopulation).toBe(0);
  });
  it.each(['procession', 'parade'] as const)(
    'admits both sidewalk crowds on one-metre %s sidewalks',
    (kind) => {
      const scene = new GroundProcessionScene({
        ...street,
        kind,
        formation: undefined,
        segments: street.segments.map((segment) => ({ ...segment, sidewalk_m: 1 })),
      });
      const spectators = new Set(
        scene.actors.filter((actor) => actor.destination).map((actor) => `test/${actor.id}`),
      );
      const admitted = scene
        .agents(0.6, 0, { scope: 'test' })
        .filter((actor) => spectators.has(eventActor(actor)!));
      expect(admitted.length).toBeGreaterThan(spectators.size * 0.9);
      expect(admitted.filter((actor) => actor.lat > street.route[0]![1]).length).toBeGreaterThan(
        20,
      );
      expect(admitted.filter((actor) => actor.lat < street.route[0]![1]).length).toBeGreaterThan(
        20,
      );
    },
  );
  it('keeps a parade actor visible through a rounded bend and rejects ground beyond it', () => {
    const frame = localMetricProjection(street.route[0]!);
    const route: StreetRoute = {
      ...street,
      kind: 'parade',
      formation: undefined,
      route: [
        [0, 0],
        [100, 0],
        [100, 100],
      ].map((q) => frame.from(q as [number, number])),
      length_m: 200,
      segments: Array.from({ length: 2 }, () => ({ id: 'osm:way/1', width_m: 8, sidewalk_m: 0 })),
    };
    const scene = new GroundProcessionScene(route),
      tail = Math.max(10, ...scene.actors.map((actor) => actor.back)) + 10;
    for (const head of [95, 99.75, 100, 101, 105])
      expect(
        scene
          .agents((head + tail) / (200 + tail), 0)
          .some((actor) => eventActor(actor)?.endsWith('/0')),
      ).toBe(true);
    expect(eventGroundAllows(scene.ground, [frame.from([102.5, -2.5])])).toBe(true);
    expect(eventGroundAllows(scene.ground, [frame.from([104, -4])])).toBe(false);
  });
  it.each([0, Math.PI / 4])('retains full minimum-width formations at heading %s', (angle) => {
    const origin = street.route[0]!,
      frame = localMetricProjection(origin);
    const formations: StreetRoute[] = [
      ...[4, 8, 24].map((bearers): StreetRoute => ({
        ...street,
        formation: { bearers, ranks: 12, marshals: 4 },
      })),
      {
        ...street,
        kind: 'parade',
        formation: {
          contingents: 3,
          ranks: 4,
          band: 12,
          color_guard: 4,
          vehicles: ['car', 'truck', 'motorcycle'],
        },
      },
    ];
    for (const route of formations) {
      const width = processionFormationWidth(
        route.kind,
        route.kind === 'parade' ? route.formation?.vehicles : [],
      );
      const scene = new GroundProcessionScene({
        ...route,
        route: [origin, frame.from([1000 * Math.cos(angle), 1000 * Math.sin(angle)])],
        length_m: 1000,
        segments: [{ id: 'osm:way/1', width_m: width, sidewalk_m: 0 }],
      });
      expect(scene.agents(0.6, 0, { crowds: false })).toHaveLength(scene.actors.length);
    }
  });
  it('admits walkers over water only on a baked bridge carriageway', () => {
    const b = new LifeBuilder();
    b.line(
      [
        { x: 0, y: 2000 },
        { x: 4096, y: 2000 },
      ],
      LifeLine.roadMinor,
      8,
      1,
      1,
    );
    const ring = [
      { x: 900, y: 1900 },
      { x: 2400, y: 1900 },
      { x: 2400, y: 2100 },
      { x: 900, y: 2100 },
      { x: 900, y: 1900 },
    ];
    b.area('blocked', [ring], true);
    const water = ring.map((q) => point(q.x, q.y));
    const bridges = [
      [
        point(900, 2000 - 4 * pm),
        point(2400, 2000 - 4 * pm),
        point(2400, 2000 + 4 * pm),
        point(900, 2000 + 4 * pm),
        point(900, 2000 - 4 * pm),
      ],
    ];
    const route = { ...street, water: [water], bridges };
    const w = new LifeWorld();
    w.setProcessions([route]);
    w.sync([{ key: 'bridge', tile, life: b.finish() }]);
    const life = worldTiles(w).get('bridge')!;
    life.movers.length = life.parked.length = life.gatherers.length = life.stalls.length = 0;
    life.scenes.sites.length = 0;
    w.setLive(route.id, 0.6, '2026');
    w.step(0.1, undefined, 18);
    expect(w.visible(18, 1, point(1500)).filter((a) => eventActor(a)).length).toBeGreaterThan(30);
    w.setProcessions([{ ...route, bridges: [] }]);
    w.step(0.1, undefined, 18);
    expect(w.visible(18, 1, point(1500)).filter((a) => eventActor(a))).toEqual([]);
  });
  it('indexes permission queries while retaining roofs and off-bridge water rejection', () => {
    const ring = (w: number, s: number, e: number, n: number): [number, number][] => [
      [w, s],
      [e, s],
      [e, n],
      [w, n],
      [w, s],
    ];
    const ground = {
      regions: [ring(0, 0, 0.01, 0.01)],
      water: [ring(0.004, 0, 0.006, 0.01)],
      bridges: [ring(0.003, 0.004, 0.007, 0.006)],
      blocked: [ring(0.0045, 0.0045, 0.0055, 0.0055)],
    };
    for (let y = 0.0001; y < 0.01; y += 0.0002)
      for (let x = 0.0001; x < 0.01; x += 0.0002) {
        const roof = x >= 0.0045 && x <= 0.0055 && y >= 0.0045 && y <= 0.0055;
        const water = x >= 0.004 && x <= 0.006;
        const bridge = x >= 0.003 && x <= 0.007 && y >= 0.004 && y <= 0.006;
        expect(eventGroundAllows(ground, [[x, y]])).toBe(!roof && (!water || bridge));
      }
    expect(eventBridgeAllows(ground, [[0.005, 0.0042]])).toBe(true);
    expect(eventBridgeAllows(ground, [[0.005, 0.002]])).toBe(false);
  });
  it('admits every permitted procession/parade formation member on an empty road', () => {
    const { w, life } = world();
    const routes: StreetRoute[] = [street, { ...street, kind: 'parade', formation: undefined }];
    for (const route of routes) {
      w.setProcessions([route]);
      w.setLive(route.id, 0.6, '2026');
      w.step(0.1, undefined, 18);
      const expected = new GroundProcessionScene(route).agents(0.6, 0);
      const admitted = w.visible(18, 1, point(1500)).filter((a) => eventActor(a));
      expect(admitted).toHaveLength(expected.length);
      expect(life.eventPopulation).toBe(expected.length);
    }
  });
  it('reuses full-world admission in a scoped birth guard without changing ownership', () => {
    const { w, life } = world();
    const candidate = new GroundProcessionScene(street).agents(0.6, 0)[0]!;
    const at = lngLatToTile(tile, candidate.lng, candidate.lat);
    life.movers.push({
      kind: 'vehicle',
      vehicle: 'car',
      line: 0,
      from: 0,
      dir: 1,
      d: at.x,
      ...at,
      hx: 1,
      hy: 0,
      speed: 0,
      v: 0,
      paint: 0,
      lane: 0,
      pause: 100,
      rank: 0,
    });
    w.setLive(street.id, 0.6, '2026');
    w.step(0.1, undefined, 18);
    const before = w.visible(18, 1, point(1500)).filter((a) => eventActor(a));
    const population = life.eventPopulation;
    const auxiliary = w as unknown as {
      groundGuard(
        min: number,
        fresh: undefined,
        bounds: undefined,
        all: boolean,
        region: ReadonlySet<typeof life>,
      ): void;
    };
    auxiliary.groundGuard(0, undefined, undefined, true, new Set());
    expect(w.visible(18, 1, point(1500)).filter((a) => eventActor(a))).toEqual(before);
    expect(life.eventPopulation).toBe(population);
  });
  it('stages Mass arrivals without admitting overlapping bodies', () => {
    const { w } = world();
    w.setLive(mass.id, 0.05, '2026');
    w.step(0.1, undefined, 18);
    const agents = w.visible(18, 1, point(1500)).filter((a) => eventActor(a));
    expect(agents.length).toBeGreaterThan(0);
    const scene = new GroundProcessionScene(mass),
      occupied = new Occupancy();
    for (const agent of agents) {
      const [x, y] = scene.frame.to([agent.lng, agent.lat]);
      const ahead = scene.frame.to(agent.ahead!),
        dx = ahead[0] - x,
        dy = ahead[1] - y;
      const d = Math.hypot(dx, dy);
      const body: Body = { x, y, hx: dx / d, hy: dy / d, length: 0.9, width: 1 };
      expect(occupied.conflicts(agent, [body])).toBe(0);
      occupied.set(agent, [body]);
    }
  });
  it('keeps event inspection ownership, movement and candle phase while held and resumes without jumping', () => {
    const scene = new GroundProcessionScene(mass),
      inspection = new LifeInspection(),
      owners = new Map<string, object>();
    const owner = (id: string) => {
      let o = owners.get(id);
      if (!o) owners.set(id, (o = {}));
      return o;
    };
    const options = { scope: 'play/1', inspection, owner };
    inspection.begin(1);
    const before = scene.agents(0.2, 1, options)[0]!;
    inspection.present(owner(eventActor(before)!), before);
    inspection.select({ id: before.inspectionId!, revision: 1, time: 1 }, 1);
    const held = scene.agents(0.22, 2, options)[0]!;
    expect([held.lng, held.lat, held.flap, held.candleSeed]).toEqual([
      before.lng,
      before.lat,
      before.flap,
      before.candleSeed,
    ]);
    inspection.select({ id: null, revision: 2, time: 2 }, 2);
    const released = scene.agents(0.22, 2, options)[0]!;
    expect([released.lng, released.lat]).toEqual([before.lng, before.lat]);
    expect(scene.agents(0.24, 3, options)[0]!.lng).not.toBe(before.lng);
  });
  it('keeps each formation footprint permitted and the parade cadence constant', () => {
    const parade: StreetRoute = {
      ...street,
      kind: 'parade',
      formation: { contingents: 2, ranks: 3, band: 8, color_guard: 4, vehicles: ['car'] },
    };
    const scene = new GroundProcessionScene(parade);
    const first = (p: number) =>
      scene.agents(p, 0, { crowds: false }).find((a) => a.glyph === ProcessionGlyph.flag)!;
    const a = first(0.3),
      b = first(0.4),
      c = first(0.5);
    expect(b.lng - a.lng).toBeCloseTo(c.lng - b.lng, 10);
    for (const p of [0.2, 0.4, 0.6, 0.8])
      for (const a of scene.agents(p, 0))
        expect(eventGroundAllows(scene.ground, [[a.lng, a.lat]])).toBe(true);
    expect(scene.agents(0.6, 0).some((a) => a.vehicle === 'car')).toBe(true);
    expect(scene.agents(0.6, 0).some((a) => a.glyph === ProcessionGlyph.drum)).toBe(true);
  });
  it('holds real approaching traffic at a physical closure and releases it on Stop', () => {
    const { w, life } = world();
    const car: Mover = {
      kind: 'vehicle',
      vehicle: 'car',
      line: 0,
      from: 0,
      dir: 1,
      d: 1000 - 25 * pm,
      x: 1000 - 25 * pm,
      y: 2000,
      hx: 1,
      hy: 0,
      speed: 5 * pm,
      v: 5 * pm,
      paint: 0,
      lane: 0,
      pause: 0,
      rank: 0,
    };
    life.movers.push(car);
    w.setLive(street.id, 0.4, '2026');
    const start = car.x;
    for (let i = 0; i < 150; i++) w.step(0.1, undefined, 18);
    expect(car.x).toBeLessThan(1000 + 20 * pm);
    expect(car.v).toBe(0);
    w.setLive(undefined);
    w.stop();
    for (let i = 0; i < 100; i++) w.step(0.1, undefined, 18);
    expect(car.x).toBeGreaterThan(start + 30 * pm);
  });
  it('holds traffic at Mass overflow and releases it on Stop and completion', () => {
    const { w, life } = world();
    const car: Mover = {
      kind: 'vehicle',
      vehicle: 'car',
      line: 0,
      from: 0,
      dir: 1,
      d: 1200,
      x: 1200,
      y: 2000,
      hx: 1,
      hy: 0,
      speed: 5 * pm,
      v: 5 * pm,
      paint: 0,
      lane: 0,
      pause: 0,
      rank: 0,
    };
    life.movers.push(car);
    w.setLive(mass.id, 0.5, '2026');
    for (let i = 0; i < 150; i++) w.step(0.1, undefined, 18);
    expect(car.v).toBe(0);
    const held = car.x;
    w.setLive(undefined);
    w.stop();
    for (let i = 0; i < 100; i++) w.step(0.1, undefined, 18);
    expect(car.x).toBeGreaterThan(held + 20 * pm);
    w.play(mass.id, eventOccurrence(mass.schedule, new Date('2026-06-01')));
    w.step(180, undefined, 18);
    expect(w.procession()).toBeUndefined();
    expect(life.eventPopulation).toBe(0);
    expect(w.visible(18, 1, point(1500)).some((a) => eventActor(a))).toBe(false);
    expect(new GroundProcessionScene(mass).agents(1, 0)).toEqual([]);
  });
  it('holds traffic before a reserved span across a tile seam, then transfers after release', () => {
    const { w, life } = world(),
      other = { ...tile, x: tile.x + 1 },
      b = new LifeBuilder();
    b.line(
      [
        { x: 0, y: 2000 },
        { x: 4096, y: 2000 },
      ],
      LifeLine.roadMinor,
      8,
      1,
      1,
    );
    w.sync([
      { key: 'road', tile, life: life.geo },
      { key: 'next', tile: other, life: b.finish() },
    ]);
    const next = worldTiles(w).get('next')!;
    next.movers.length = next.parked.length = next.gatherers.length = next.stalls.length = 0;
    next.scenes.sites.length = 0;
    const points = Array.from({ length: 51 }, (_, i) => point(4096 - 20 * pm + i * 4 * pm));
    const crossing = { ...street, route: points };
    w.setProcessions([crossing]);
    const car: Mover = {
      kind: 'vehicle',
      vehicle: 'car',
      line: 0,
      from: 0,
      dir: 1,
      d: 4096 - 45 * pm,
      x: 4096 - 45 * pm,
      y: 2000,
      hx: 1,
      hy: 0,
      speed: 5 * pm,
      v: 5 * pm,
      paint: 0,
      lane: 0,
      pause: 0,
      rank: 0,
    };
    life.movers.push(car);
    w.setLive(street.id, 0.4, '2026');
    for (let i = 0; i < 80; i++) w.step(0.1, undefined, 18);
    const entrance = new GroundProcessionScene(crossing).spans(0.4)[0]!.a;
    expect(car.v).toBe(0);
    expect(car.x).toBeLessThan(lngLatToTile(tile, ...entrance).x);
    const visible = w.visible(18, 1, point(4096));
    expect(new Set(visible.filter((a) => eventActor(a)).map((a) => eventActor(a))).size).toBe(
      visible.filter((a) => eventActor(a)).length,
    );
    expect(life.population).toBeLessThanOrEqual(MAX_TILE_AGENTS);
    expect(next.population).toBeLessThanOrEqual(MAX_TILE_AGENTS);
    w.setLive(undefined);
    w.stop();
    for (let i = 0; i < 150; i++) w.step(0.1, undefined, 18);
    expect(next.movers).toContain(car);
    expect(car.v).toBeGreaterThan(0);
  });
  it('uses tile and visible capacity, including props, and clears repeated playback ownership', () => {
    const { w, life } = world();
    life.movers.push(
      ...Array.from({ length: 40 }, (_, i) => ordinaryPerson(3000 + i * pm, 2000 + 4.5 * pm)),
    );
    const bounds: [number, number, number, number] = [
      point(0, 4096)[0],
      point(0, 4096)[1],
      point(4096, 0)[0],
      point(4096, 0)[1],
    ];
    expect(
      w.visible(18, 1, point(1500), undefined, bounds).filter((actor) => !eventActor(actor)).length,
    ).toBeGreaterThan(30);
    w.setLive(street.id, 0.6, '2026');
    w.step(0.1, undefined, 18);
    const event = w.visible(18, 1, point(1500), undefined, bounds, 1, 30);
    expect(event.length).toBeLessThanOrEqual(30);
    expect(event.some((a) => eventActor(a))).toBe(true);
    expect(life.population).toBeLessThanOrEqual(MAX_TILE_AGENTS);
    for (let repeat = 0; repeat < 3; repeat++) {
      w.play(street.id);
      w.step(0.1);
      w.stop();
      expect(life.eventPopulation).toBe(0);
    }
    life.movers.length = 0;
    life.movers.push(
      ...Array.from({ length: MAX_TILE_AGENTS }, (): Mover => ({
        kind: 'person',
        line: 0,
        from: 0,
        dir: 1,
        d: 0,
        x: 1,
        y: 2000,
        hx: 1,
        hy: 0,
        speed: 0,
        paint: 0,
        lane: 0,
        pause: 10,
        rank: 1,
      })),
    );
    w.setLive(mass.id, 0.5, '2026');
    w.step(0.1, undefined, 18);
    expect(life.population).toBeLessThanOrEqual(MAX_TILE_AGENTS);
    expect(life.eventPopulation).toBe(0);
  });
  it('walks a single Mass gathering in, holds facing the church and walks it out', () => {
    const scene = new GroundProcessionScene(mass);
    const entering = scene.agents(0.2, 1),
      standing = scene.agents(0.5, 1),
      leaving = scene.agents(0.9, 1);
    expect(standing.length).toBeGreaterThan(10);
    expect(standing.every((a) => a.flap === 0)).toBe(true);
    expect(entering.map((a) => [a.lng, a.lat])).not.toEqual(standing.map((a) => [a.lng, a.lat]));
    expect(leaving.map((a) => [a.lng, a.lat])).not.toEqual(standing.map((a) => [a.lng, a.lat]));
    for (const a of [...entering, ...standing, ...leaving])
      expect(eventGroundAllows(scene.ground, [[a.lng, a.lat]])).toBe(true);
    scene.adopt(standing.slice(0, 10));
    const adopted = scene.agents(0, 2).slice(0, 10);
    expect(adopted.map((a) => eventActor(a))).toEqual(
      standing.slice(0, 10).map((a) => eventActor(a)),
    );
    expect(adopted.map((a) => [a.lng, a.lat, a.candle, a.candleSeed])).toEqual(
      standing.slice(0, 10).map((a) => [a.lng, a.lat, a.candle, a.candleSeed]),
    );
    expect(scene.spans(0.5)).toEqual([]);
  });
  it('adopts at grid-cell edges and rejects permitted but disconnected ground', () => {
    const scene = new GroundProcessionScene(mass);
    const actor = scene.agents(0.5, 0)[20]!;
    const q = scene.frame.to([actor.lng, actor.lat]);
    const shifted = scene.frame.from([q[0] + 0.99, q[1] + 0.99]);
    scene.adopt([identifyEventActor({ ...actor, lng: shifted[0], lat: shifted[1] }, 'retained')]);
    expect(scene.agents(0, 0).some((a) => eventActor(a) === 'retained')).toBe(true);
    const extra: [number, number][] = [
      [350, 0],
      [360, 0],
      [360, 10],
      [350, 10],
      [350, 0],
    ].map((p) => scene.frame.from(p as [number, number]));
    const separated = new GroundProcessionScene({
      ...mass,
      id: 'procession/separated',
      site: { ...mass.site, grounds: [...mass.site.grounds, extra] },
    });
    const remote = separated.frame.from([356, 6]);
    separated.adopt([identifyEventActor({ ...actor, lng: remote[0], lat: remote[1] }, 'remote')]);
    expect(separated.agents(0, 0).some((a) => eventActor(a) === 'remote')).toBe(false);
  });
  it('adopts nearby predecessor actors without duplicate admission and preserves them across camera changes', () => {
    const { w } = world();
    w.setLive(street.id, 0.9, '2026');
    w.step(0.1, undefined, 18);
    const before = w
      .visible(18, 1, point(1500))
      .filter((a) => eventActor(a) && a.kind === 'person' && !a.prop);
    w.setLive(mass.id, 0, '2026');
    w.step(0.1, undefined, 18);
    const after = w.visible(18, 1, point(1500)).filter((a) => eventActor(a));
    const retained = after.filter((a) => before.some((b) => eventActor(b) === eventActor(a)));
    expect(retained.length).toBeGreaterThan(0);
    for (const a of retained) {
      const old = before.find((b) => eventActor(b) === eventActor(a))!;
      expect([a.lng, a.lat, a.candleSeed]).toEqual([old.lng, old.lat, old.candleSeed]);
    }
    expect(new Set(after.map((a) => eventActor(a))).size).toBe(after.length);
    expect(w.visible(18, 1, point(1400)).map((a) => eventActor(a))).toEqual(
      w.visible(18, 1, point(1500)).map((a) => eventActor(a)),
    );
  });
  it.each(['fluvial-live', 'street-played'] as const)(
    'retains arrival identities and inspection ownership from %s',
    (kind) => {
      const { w, life } = world(true);
      const river: FluvialRoute = {
        id: 'procession/river',
        kind: 'fluvial',
        title: street.title,
        status: street.status,
        route: street.route,
        banks: street.route.map(() => [0, 0]),
        length_m: street.length_m,
        schedule: street.schedule,
      };
      const predecessor = kind === 'fluvial-live' ? river : street;
      const arrival = { ...mass, follows: predecessor.id };
      w.setProcessions([predecessor, arrival]);
      if (kind === 'fluvial-live') {
        w.setLive(river.id, 0.99, 'test');
        w.step(0.1, undefined, 18);
      } else {
        w.play(street.id, eventOccurrence(street.schedule, new Date('2026-06-01')));
        w.step(162, undefined, 18);
      }
      const before = w
        .visible(18, 1, point(1500))
        .filter((actor) => actor.kind === 'person' && !actor.prop && !actor.aboard);
      expect(before.length).toBeGreaterThan(0);
      if (kind === 'fluvial-live') {
        w.setLive(arrival.id, 0, 'test');
        w.step(0.1, undefined, 18);
      } else {
        w.play(arrival.id, eventOccurrence(arrival.schedule, new Date('2026-06-01')));
        w.step(1e-6, undefined, 18);
      }
      const after = w.visible(18, 1, point(1500)).filter((actor) => eventActor(actor));
      const retained = after.filter((actor) =>
        before.some((old) => old.inspectionId === actor.inspectionId),
      );
      expect(retained.length).toBeGreaterThan(0);
      for (const actor of retained) {
        const old = before.find((candidate) => candidate.inspectionId === actor.inspectionId)!;
        expect(actor.lng).toBeCloseTo(old.lng, 8);
        expect(actor.lat).toBeCloseTo(old.lat, 8);
        expect([actor.paint, actor.candle, actor.candleSeed]).toEqual([
          old.paint,
          old.candle,
          old.candleSeed,
        ]);
      }
      expect(new Set(after.map((actor) => eventActor(actor))).size).toBe(after.length);
      expect(life.population).toBeLessThanOrEqual(MAX_TILE_AGENTS);
      w.stop();
      w.setLive(undefined);
      expect(life.eventPopulation).toBe(0);
    },
  );
  it.each(['stop', 'completion', 'no-playback'] as const)(
    'preserves adopted live Mass actors and inspection tokens after %s',
    (end) => {
      const { w } = world(true);
      w.setLive(street.id, 0.9, '2026');
      w.step(0.1, undefined, 18);
      const predecessor = w.visible(18, 1, point(1500));
      w.setLive(mass.id, 0, '2026');
      w.step(0.1, undefined, 18);
      const before = w
        .visible(18, 1, point(1500))
        .filter((a) => predecessor.some((b) => b.inspectionId === a.inspectionId));
      expect(before.length).toBeGreaterThan(0);
      if (end !== 'no-playback') {
        w.play(street.id, eventOccurrence(street.schedule, new Date('2026-06-01')));
        w.step(end === 'completion' ? 180 : 1, undefined, 18);
      }
      w.stop();
      w.step(0.1, undefined, 18);
      const after = w.visible(18, 1, point(1500));
      for (const actor of before) {
        const retained = after.find((a) => eventActor(a) === eventActor(actor));
        expect(retained).toBeDefined();
        expect([
          retained!.inspectionId,
          retained!.paint,
          retained!.candleSeed,
          retained!.lng,
          retained!.lat,
        ]).toEqual([actor.inspectionId, actor.paint, actor.candleSeed, actor.lng, actor.lat]);
      }
      w.setProcessions([street, mass]);
      w.setLive(mass.id, 0, 'replacement');
      w.step(0.1, undefined, 18);
      expect(
        w
          .visible(18, 1, point(1500))
          .every((a) => !before.some((old) => eventActor(a) === eventActor(old))),
      ).toBe(true);
    },
  );
  it.each(['procession', 'parade'] as const)(
    'clears moving and parked traffic across the full %s route for live and played events, then restores identities',
    (kind) => {
      for (const live of [true, false]) {
        const { w, life } = world();
        const route: StreetRoute =
          kind === 'parade'
            ? {
                ...street,
                kind: 'parade',
                formation: {
                  contingents: 2,
                  ranks: 3,
                  band: 8,
                  color_guard: 4,
                  vehicles: ['car'],
                },
              }
            : street;
        w.setProcessions([route]);
        const car = (x: number, y = 2000): Mover => ({
          ...ordinaryPerson(x, y),
          kind: 'vehicle',
          vehicle: 'car',
          group: undefined,
          v: 0,
        });
        const start = car(1000 + 10 * pm),
          end = car(1000 + 190 * pm),
          unrelated = car(800, 2000 + 12 * pm);
        const parked = {
          x: 1000 + 190 * pm,
          y: 2000 + 4.6 * pm,
          hx: 1,
          hy: 0,
          vehicle: 'car' as const,
          paint: 0,
        };
        const offRoute = { ...parked, y: 2000 + 10 * pm };
        life.movers.push(start, end, unrelated);
        life.parked.push(parked, offRoute);
        if (live) w.setLive(route.id, 0.6, '2026');
        else {
          w.play(route.id, eventOccurrence(route.schedule, new Date('2026-06-01')));
          w.step(108, undefined, 18);
        }
        w.step(0.1, undefined, 18);
        expect(life.movers).toEqual([unrelated]);
        expect(life.parked).toEqual([offRoute]);
        expect([...life.residentMovers()]).toContain(start);
        const shown = w.visible(18, 1, point(1500));
        expect(
          shown.filter((a) => a.kind === 'vehicle' && !eventActor(a) && !a.parked),
        ).toHaveLength(1);
        if (kind === 'parade')
          expect(shown.some((a) => a.vehicle === 'car' && eventActor(a))).toBe(true);
        const newcomer = car(1000 + 170 * pm);
        const guardWorld = w as unknown as {
          groundGuard(): (target: typeof life, owner: Mover) => boolean;
        };
        expect(guardWorld.groundGuard()(life, newcomer)).toBe(false);
        // A freshly loaded tile on the route must also yield its ordinary vehicles.
        w.sync([
          { key: 'road', tile, life: life.geo },
          {
            key: 'new',
            tile: { ...tile, z: tile.z + 1, x: tile.x * 2, y: tile.y * 2 },
            life: life.geo,
          },
        ]);
        w.sync([{ key: 'road', tile, life: life.geo }]);
        w.step(0.1, undefined, 18);
        expect(life.movers).not.toContain(start);
        expect(life.movers).not.toContain(end);
        if (live) w.setLive(route.id, 1, '2026');
        else w.stop();
        expect(life.movers).toEqual([start, end, unrelated]);
        expect(life.parked).toEqual([parked, offRoute]);
        expect(guardWorld.groundGuard()(life, newcomer)).toBe(true);
        if (!live) {
          w.play(route.id, eventOccurrence(route.schedule, new Date('2026-06-01')));
          expect(life.movers).not.toContain(start);
          w.step(180, undefined, 18);
          expect(w.procession()).toBeUndefined();
          expect(life.movers).toContain(start);
          expect(life.parked).toContain(parked);
        }
      }
    },
  );
  it('reuses event time only at unchanged progress and retains exact sub-minute time', () => {
    const { w } = world();
    const timing = eventOccurrence(street.schedule, new Date('2026-06-01'));
    w.play(street.id, timing);
    const time = w.procession()!.time!;
    expect(w.procession()!.time).toBe(time);
    w.step(0.01);
    const next = w.procession()!.time!;
    expect(next.minute).toBe(time.minute);
    expect(next.instantMs).toBeGreaterThan(time.instantMs);
    expect(w.procession()!.time).toBe(next);
    w.stop();
    w.play(street.id, timing);
    expect(w.procession()!.time!.instantMs).toBe(time.instantMs);
    expect(w.procession()!.time).not.toBe(time);
    w.step(180);
    expect(w.procession()).toBeUndefined();
  });
  it.each(['procession', 'mass'] as const)(
    'respects saturated tile quotas for %s across a seam',
    (kind) => {
      const { w, life } = world();
      w.sync([
        { key: 'road', tile, life: life.geo },
        { key: 'neighbor', tile: { ...tile, x: tile.x + 1 }, life: life.geo },
      ]);
      const next = worldTiles(w).get('neighbor')!;
      for (const target of [life, next]) {
        target.movers.length =
          target.parked.length =
          target.stalls.length =
          target.gatherers.length =
            0;
        target.scenes.sites.length = 0;
        target.movers.push(
          ...Array.from({ length: MAX_TILE_AGENTS - 5 }, () => ordinaryPerson(3000, 2000, 99)),
        );
      }
      const dx = 4096 - lngLatToTile(tile, ...mass.site.anchor).x;
      const shift = (q: [number, number]) => {
        const at = lngLatToTile(tile, ...q);
        return point(at.x + dx, at.y);
      };
      const crossing: StreetRoute = {
        ...street,
        route: street.route.map((_, i) => point(4096 - 100 * pm + i * 4 * pm)),
      };
      const gathering: MassRoute = {
        ...mass,
        site: {
          ...mass.site,
          location: shift(mass.site.location),
          anchor: shift(mass.site.anchor),
          grounds: mass.site.grounds.map((ring) => ring.map(shift)),
          approaches: mass.site.approaches.map((line) => line.map(shift)),
        },
      };
      const route = kind === 'mass' ? gathering : crossing;
      w.setProcessions([route]);
      w.visible(18, 1, point(4096));
      w.setLive(route.id, kind === 'mass' ? 0.5 : 0.6, 'test');
      w.step(0.1, undefined, 18);
      for (const target of [life, next]) {
        expect(target.population).toBeLessThanOrEqual(MAX_TILE_AGENTS);
        expect(target.eventPopulation).toBeGreaterThan(0);
        expect(target.eventPopulation).toBeLessThanOrEqual(5);
      }
      const actors = w.visible(18, 1, point(4096)).filter((actor) => eventActor(actor));
      expect(new Set(actors.map((actor) => eventActor(actor))).size).toBe(actors.length);
      w.setLive(undefined);
      expect(life.eventPopulation + next.eventPopulation).toBe(0);
    },
  );
  it('uses resolved live rules on September 11 at 12:30 and September 18 at 07:30 in Manila', () => {
    expect(liveProgress(street.schedule, new Date('2026-09-11T04:30:00Z'))).toBe(30 / 240);
    const parade = { ...street.schedule, offset_days: -1, start: '07:00', duration_min: 120 };
    expect(liveProgress(parade, new Date('2026-09-17T23:30:00Z'))).toBe(0.25);
    expect(liveProgress(mass.schedule, new Date('2026-09-11T08:30:00Z'))).toBe(30 / 90);
  });
  it('carries authoritative event time through inline play and restores it on Stop/completion', () => {
    const { w } = world(),
      host = createInlineHost(w),
      timing = eventOccurrence(street.schedule, new Date('2026-06-01'));
    host.play(street.id, timing);
    expect(host.latest()?.procession?.time?.time).toBe('12:00');
    w.step(1);
    expect(w.signalClock).toBeCloseTo(0.1);
    expect(host.latest()?.procession?.progress).toBeCloseTo(1 / 180);
    expect(host.latest()?.procession?.time?.time).toBe('12:01');
    for (let i = 0; i < 20; i++) w.step(0.1);
    expect(host.latest()?.procession?.time?.minute).toBeGreaterThan(720);
    host.stop();
    expect(host.latest()?.procession).toBeUndefined();
    w.clearTiles();
    host.play(street.id, timing);
    w.step(180);
    expect(host.latest()?.procession).toBeUndefined();
    host.dispose();
  });
  it('packs bounded street people and props across inline and transferred cell guards', () => {
    const glyphs = mapGlyphs(themes.dark),
      index = (g: string) => glyphs.indexOf(g) + 1,
      out = new Uint8Array(40 * 20 * 4);
    const agent = new GroundProcessionScene(street).agents(0.6, 0).find((a) => a.prop)!;
    const project = (lng: number, lat: number): [number, number] => [
      (lng - agent.lng) * 100000 + 20,
      (agent.lat - lat) * 100000 + 10,
    ];
    const empty = { hits: () => false },
      forbidden = { hits: () => true };
    const guard = makeCellGuard(
      { tile, perMeter: pm },
      { roads: forbidden, forbidden },
      empty,
      project,
      new Map([[street.id, groundForRoute(street)]]),
    );
    const count = packLife(
      out,
      {
        cols: 40,
        rows: 20,
        cellWidth: 10,
        cellHeight: 18,
        toCell: project,
        allowsGroundCell: guard,
      },
      [agent],
      themes.dark,
      index,
      undefined,
      buildLifeGlyphs(index),
    );
    expect(count).toBe(1);
    expect(out.some((b) => b !== 0)).toBe(true);
    const permissions = Array.from({ length: 800 }, (_, i) => out[i * 4 + 2]!).filter(Boolean);
    expect(permissions).toEqual([EVENT_PERSON_BITS]);
    expect(EVENT_PERSON_BITS).not.toBe(CellBit.person);
    expect(EVENT_PERSON_BITS).not.toBe(CellBit.vehicle | CellBit.person);
    expect(PROCESSION_GLYPHS).toContain(agent.glyph);
    expect(guard({ ...agent, eventGround: undefined, prop: undefined }, 20, 10)).toBe(false);
    expect(guard({ ...agent, eventGround: 'unknown' }, 20, 10)).toBe(false);
    expect(typeof structuredClone(agent).eventGround).toBe('string');
    expect(groundForRoute(street)).toBe(groundForRoute(street));
    expect(guard(agent, 0, 0)).toBe(false);
  });
});
