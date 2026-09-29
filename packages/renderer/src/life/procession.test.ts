import type { ProcessionRoute } from '@atlas/shared';
import { describe, expect, it } from 'vitest';
import { LifeLine, LifeBuilder } from './geometry';
import { liveProgress, PROCESSION, ProcessionScene, scheduledDay } from './procession';
import { LifeWorld } from './simulate';
import { BOAT_PAINTS_AVOID, VEHICLES } from './vehicles';

/** A straight route 1,000 m due east along the equator (0.001° ≈ 111.3 m). */
const route: ProcessionRoute = {
  id: 'procession/test',
  title: { en: 'Test' },
  status: 'draft',
  kind: 'fluvial',
  route: [
    [0, 0],
    [1000 / 111_320, 0],
  ],
  length_m: 1000,
  schedule: {
    month: 9,
    weekday: 0,
    nth: 3,
    offset_days: -1,
    start: '15:00',
    duration_min: 180,
    timezone: 'Asia/Manila',
  },
};
/** Meters east of the route's start. */
const east = (lng: number) => lng * 111_320;

describe('ProcessionScene', () => {
  const scene = new ProcessionScene(route);
  const boats = (progress: number) => scene.agents(progress, 0, { crowds: false });

  it('tows the pagoda behind columns of voyadores, downstream', () => {
    const agents = boats(0.5);
    const pagoda = agents.find((a) => a.vehicle === 'pagoda')!;
    const voyadores = agents.filter((a) => a.vehicle === 'voyador');
    expect(voyadores).toHaveLength(PROCESSION.columns * PROCESSION.ranks);
    // All ahead of the pagoda, facing downstream (east).
    expect(voyadores.every((v) => east(v.lng) > east(pagoda.lng))).toBe(true);
    for (const a of agents) expect(east(a.ahead![0]) - east(a.lng)).toBeCloseTo(1, 1);
    // Three columns across the river.
    expect(new Set(voyadores.map((v) => Math.round(v.lat * 110_540))).size).toBe(
      PROCESSION.columns,
    );
  });

  it('enters from the start and ends with the pagoda at the landing', () => {
    expect(boats(0).find((a) => a.vehicle === 'pagoda')).toBeUndefined();
    const end = boats(1).find((a) => a.vehicle === 'pagoda')!;
    expect(east(end.lng)).toBeCloseTo(1000, 0);
    // Nothing is drawn past the landing.
    expect(boats(1).every((a) => east(a.lng) <= 1000.5)).toBe(true);
  });

  it('lines the banks with crowds, thickest around the pagoda, some with candles', () => {
    const people = scene.agents(0.5, 0, { boats: false });
    expect(people.length).toBeGreaterThan(0);
    expect(people.every((p) => p.kind === 'person')).toBe(true);
    const offsets = people.map((p) => Math.abs(p.lat * 110_540));
    expect(Math.min(...offsets)).toBeGreaterThanOrEqual(PROCESSION.crowdBand[0] - 1);
    expect(Math.max(...offsets)).toBeLessThanOrEqual(PROCESSION.crowdBand[1] + 1);
    expect(people.some((p) => p.candle)).toBe(true);
    expect(people.some((p) => !p.candle)).toBe(true);
    const pagoda = east(boats(0.5).find((a) => a.vehicle === 'pagoda')!.lng);
    const near = people.filter((p) => Math.abs(east(p.lng) - pagoda) < 100).length;
    const far = people.filter((p) => Math.abs(east(p.lng) - (pagoda - 350)) < 100).length;
    expect(near).toBeGreaterThan(far * 2);
  });

  it('paints its boats in colors that stand out from the water', () => {
    for (const craft of ['pagoda', 'voyador'] as const) {
      for (const paint of VEHICLES[craft].paints) expect(BOAT_PAINTS_AVOID).not.toContain(paint);
    }
  });
});

describe('liveProgress', () => {
  const { schedule } = route;

  it('finds the day: the Saturday before the third Sunday of September', () => {
    const day = (y: number, m: number, d: number) => Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
    expect(scheduledDay(schedule, 2026)).toBe(day(2026, 9, 19));
    expect(scheduledDay(schedule, 2025)).toBe(day(2025, 9, 20));
  });

  it('runs through its window in the city’s time zone', () => {
    // Manila is UTC+8: 15:00 there is 07:00 UTC.
    expect(liveProgress(schedule, new Date('2026-09-19T06:59:00Z'))).toBeUndefined();
    expect(liveProgress(schedule, new Date('2026-09-19T07:00:00Z'))).toBe(0);
    expect(liveProgress(schedule, new Date('2026-09-19T08:30:00Z'))).toBeCloseTo(0.5);
    expect(liveProgress(schedule, new Date('2026-09-19T10:00:00Z'))).toBeUndefined();
    expect(liveProgress(schedule, new Date('2026-09-20T08:30:00Z'))).toBeUndefined();
  });
});

describe('LifeWorld processions', () => {
  const b = new LifeBuilder();
  b.line(
    [
      { x: 0, y: 2048 },
      { x: 4095, y: 2048 },
    ],
    LifeLine.river,
  );
  const river = b.finish();
  const tile = { z: 16, x: 55192, y: 30266 };
  const center: [number, number] = [123.18, 13.62];

  it('plays one as a time-lapse, closing the river to other boats, then ends', () => {
    const world = new LifeWorld();
    world.setProcessions([route]);
    world.sync([{ key: 'r', tile, life: river }]);
    const regular = () =>
      world
        .visible(16, 1, center)
        .filter((a) => a.kind === 'boat' && !a.vehicle?.match(/pagoda|voyador/));
    expect(world.procession()).toBeUndefined();
    // Before: the river's own boats, far from this test route near 0°E.
    expect(regular().some((a) => a.lng > 1)).toBe(true);
    expect(world.play('procession/nope')).toBe(false);
    expect(world.play(route.id)).toBe(true);
    for (let i = 0; i < 900; i++) world.step(0.1);
    expect(world.procession()).toMatchObject({ id: route.id, live: false });
    expect(world.procession()!.progress).toBeCloseTo(0.5, 1);
    const agents = world.visible(16, 1, center);
    // Its boats come first, and other river traffic is gone.
    expect(agents[0]!.vehicle).toMatch(/pagoda|voyador|banca|motorboat/);
    expect(agents.some((a) => a.vehicle === 'pagoda')).toBe(true);
    expect(regular().every((a) => a.lng < 1)).toBe(true);
    for (let i = 0; i < 1000; i++) world.step(0.1);
    expect(world.procession()).toBeUndefined();
  });

  it('shows a live one by its schedule, and a played one over it', () => {
    const world = new LifeWorld();
    world.setProcessions([route]);
    world.setLive(route.id, 0.25);
    expect(world.procession()).toEqual({ id: route.id, progress: 0.25, live: true });
    world.play(route.id);
    expect(world.procession()!.live).toBe(false);
    world.stop();
    expect(world.procession()!.live).toBe(true);
    world.setLive(undefined);
    expect(world.procession()).toBeUndefined();
  });
});
