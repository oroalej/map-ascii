import type { ProcessionRoute } from '@atlas/shared';
import { describe, expect, it } from 'vitest';
import { LifeLine, LifeBuilder } from './geometry';
import {
  liveProgress,
  motionProfile,
  PROCESSION,
  ProcessionScene,
  profileAt,
  scheduledDay,
  routePolyline,
} from './procession';
import { SHIRT_PAINTS } from './people';
import { LifeWorld } from './simulate';
import { LifeInspection } from './inspection';
import { BOAT_PAINTS_AVOID, Paint, VEHICLES } from './vehicles';

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
it('samples endpoints and zero-length route edges with a defined heading', () => {
  const route = routePolyline([
    [0, 0],
    [0, 0],
    [0, 10],
  ]);
  expect(route.at(-1)).toMatchObject({ x: 0, y: 0, hx: 0, hy: 1 });
  expect(route.at(5)).toMatchObject({ x: 0, y: 5, hx: 0, hy: 1 });
  expect(route.at(20)).toMatchObject({ x: 0, y: 10, hx: 0, hy: 1 });
  expect(
    routePolyline([
      [0, 0],
      [0, 0],
    ]).at(0),
  ).toMatchObject({ x: 0, y: 0, hx: 1, hy: 0 });
});
it('keeps bank candle seeds stable and emits identities only for arrival handover', () => {
  const scene = new ProcessionScene(route),
    options = { boats: false, crowds: true, crews: false };
  const first = scene.agents(0.5, 1, options),
    next = scene.agents(0.5, 2, options);
  expect(first.length).toBeGreaterThan(0);
  expect(next.map((actor) => actor.candleSeed)).toEqual(first.map((actor) => actor.candleSeed));
  expect(first.every((actor) => actor.eventActor === undefined)).toBe(true);
  const arrival = scene.arrivalCrowd(0.5, 1, 'play/1'),
    owners = scene.arrivalOwners('play/1');
  expect(arrival.map((actor) => actor.candleSeed)).toEqual(first.map((actor) => actor.candleSeed));
  expect(arrival.every((actor) => owners.has(actor.eventActor!))).toBe(true);
  expect(new Set(arrival.map((actor) => actor.eventActor)).size).toBe(arrival.length);
});

it.each(['voyador', 'pagoda', 'crew'] as const)(
  'holds the connected towing formation through its %s',
  (craft) => {
    const scene = new ProcessionScene(route),
      inspection = new LifeInspection();
    const agents = (progress: number, clock: number) => {
      inspection.begin(clock);
      const result = scene.agents(progress, clock, { inspection, crews: true });
      inspection.finish(result);
      return result;
    };
    const before = agents(0.4, 10);
    const selected = before.find((a) =>
      craft === 'crew' ? a.aboard && a.kind === 'person' : a.vehicle === craft,
    )!;
    expect(
      new Set(
        before
          .filter((a) => a.vehicle === 'voyador' || a.vehicle === 'pagoda')
          .map((a) => a.inspectionId),
      ).size,
    ).toBe(1);
    inspection.select({ id: selected.inspectionId!, revision: 1, time: 10 }, 10);
    const after = agents(0.45, 40);
    expect(after.filter((a) => a.inspectionId === selected.inspectionId)).toEqual(
      before.filter((a) => a.inspectionId === selected.inspectionId),
    );
    expect(after.filter((a) => a.line)).toEqual(before.filter((a) => a.line));
    const old = new Map(before.filter((a) => a.vehicle).map((a) => [a.inspectionId, a]));
    expect(
      after.some(
        (a) =>
          a.vehicle &&
          a.inspectionId !== selected.inspectionId &&
          old.has(a.inspectionId) &&
          a.lng !== old.get(a.inspectionId)!.lng,
      ),
    ).toBe(true);
    inspection.select({ id: null, revision: 2, time: 40 }, 40);
    const resumed = agents(0.4501, 40.02).find(
      (a) => a.vehicle === selected.vehicle && a.inspectionId === selected.inspectionId,
    )!;
    expect(Math.abs(east(resumed.lng) - east(selected.lng))).toBeLessThan(1);
  },
);

it('preserves connected formation delay across replay without delaying independent boats', () => {
  const world = new LifeWorld(undefined, undefined, undefined, true);
  world.setProcessions([route]);
  const agents = () => world.visible(18, 1, [0, 0]);
  world.setLive(route.id, 0.4, 'test/2026');
  const selected = agents().find((a) => a.vehicle === 'pagoda')!;
  world.inspection!.select({ id: selected.inspectionId!, revision: 1, time: 0 }, 0);
  world.setLive(route.id, 0.5, 'test/2026');
  agents();
  world.inspection!.select({ id: null, revision: 2, time: 10 }, 0);
  const delayed = agents().find(
    (a) => a.vehicle === 'pagoda' && a.inspectionId === selected.inspectionId,
  )!;
  expect(delayed.lng).toBe(selected.lng);
  world.play(route.id);
  agents();
  world.stop();
  expect(
    agents().find((a) => a.vehicle === 'pagoda' && a.inspectionId === selected.inspectionId),
  ).toEqual(delayed);
  world.setLive(route.id, 0.5, 'test/2027');
  expect(agents().some((a) => a.inspectionId === selected.inspectionId)).toBe(false);
});

describe('ProcessionScene', () => {
  const scene = new ProcessionScene(route);
  const boats = (progress: number, time = 0) =>
    scene.agents(progress, time, { crowds: false }).filter((a) => !a.line);
  const lines = (progress: number, time = 0) =>
    scene.agents(progress, time, { crowds: false }).filter((a) => a.line);
  /** Meters right of the route (it runs east, so right is south). */
  const right = (lat: number) => -lat * 110_540;
  const pagodaEast = (progress: number) =>
    east(boats(progress).find((a) => a.vehicle === 'pagoda')!.lng);

  it('tows the pagoda behind loose columns of voyadores, heading along the river', () => {
    const agents = boats(0.5, 7);
    const pagoda = pagodaEast(0.5);
    const voyadores = agents.filter((a) => a.vehicle === 'voyador');
    expect(voyadores).toHaveLength(PROCESSION.columns * PROCESSION.ranks);
    expect(voyadores.every((v) => east(v.lng) > pagoda)).toBe(true);
    // Facing along the river, give or take their sway.
    for (const a of agents) expect(east(a.ahead![0]) - east(a.lng)).toBeGreaterThan(0.98);
    // Three columns across the river, but not in straight lines.
    const across = voyadores.map((v) => right(v.lat));
    expect(Math.max(...across) - Math.min(...across)).toBeGreaterThan(PROCESSION.columnGap * 1.5);
    expect(new Set(across.map((x) => x.toFixed(1))).size).toBeGreaterThan(PROCESSION.columns * 3);
  });

  it('enters from the start and ends with the pagoda at the landing', () => {
    expect(boats(0).find((a) => a.vehicle === 'pagoda')).toBeUndefined();
    expect(pagodaEast(1)).toBeCloseTo(1000, 0);
    // Nothing is drawn past the landing.
    expect(boats(1).every((a) => east(a.lng) <= 1000.5)).toBe(true);
  });

  it('brings a flotilla of small boats behind the pagoda', () => {
    const pagoda = pagodaEast(0.7);
    const small = boats(0.7).filter((a) =>
      ['baroto', 'rowboat', 'motorboat', 'sailboat'].includes(a.vehicle!),
    );
    const behind = small.filter((a) => east(a.lng) < pagoda);
    expect(behind.length).toBeGreaterThanOrEqual(PROCESSION.followers - 1);
    expect(new Set(behind.map((a) => a.vehicle)).size).toBeGreaterThanOrEqual(3);
  });

  it('keeps every hull inside the banks, even where the river is narrow', () => {
    const narrow = new ProcessionScene({
      ...route,
      id: 'procession/narrow',
      banks: [
        [4, 6],
        [4, 6],
      ],
    });
    for (let p = 0; p <= 1; p += 0.02) {
      for (const a of narrow.agents(p, p * 97, { crowds: false }).filter((x) => !x.line)) {
        const off = right(a.lat);
        const half = VEHICLES[a.vehicle!].width / 2;
        expect(off - half).toBeGreaterThanOrEqual(-4 + PROCESSION.bankMargin - 1e-6);
        expect(off + half).toBeLessThanOrEqual(6 - PROCESSION.bankMargin + 1e-6);
      }
    }
  });

  it('lines the banks with crowds, thickest around the pagoda, some with candles', () => {
    const people = scene.agents(0.5, 0, { boats: false });
    expect(people.every((p) => p.kind === 'person')).toBe(true);
    // From the default banks back into the town.
    const bank = PROCESSION.defaultBank;
    const offsets = people.map((p) => Math.abs(right(p.lat)));
    expect(Math.min(...offsets)).toBeGreaterThanOrEqual(bank + PROCESSION.crowdDepth[0] - 0.5);
    expect(Math.max(...offsets)).toBeLessThanOrEqual(bank + PROCESSION.crowdDepth[1] + 0.5);
    expect(people.some((p) => p.candle)).toBe(true);
    expect(people.some((p) => !p.candle)).toBe(true);
    // Facing the river, in shirts of many colors.
    for (const p of people) {
      expect(Math.abs(right(p.ahead![1]))).toBeLessThan(Math.abs(right(p.lat)));
      expect(SHIRT_PAINTS).toContain(p.paint);
    }
    expect(new Set(people.map((p) => p.paint)).size).toBeGreaterThan(3);
    const pagoda = scene.pagodaAt(0.5);
    const far = pagoda > 500 ? pagoda - 300 : pagoda + 300;
    const count = (at: number) => people.filter((p) => Math.abs(east(p.lng) - at) < 100).length;
    expect(count(pagoda)).toBeGreaterThan(count(far) * 2);
  });

  it('leaves out the crowds outside the view', () => {
    const people = scene.agents(0.5, 0, { boats: false });
    const lngs = people.map((p) => p.lng).sort((a, b) => a - b);
    const middle = lngs[Math.floor(lngs.length / 2)]!;
    const lats = people.map((p) => p.lat);
    const bounds = [lngs[0]! - 1, Math.min(...lats) - 1, middle, Math.max(...lats) + 1] as const;
    const inView = scene.agents(0.5, 0, { boats: false, bounds });
    expect(inView.length).toBeGreaterThan(0);
    expect(inView.length).toBeLessThan(people.length);
    // Everyone in view, where they stand without bounds, and no one far outside it.
    const at = (p: { lng: number; lat: number }) => `${p.lng},${p.lat}`;
    const shown = new Set(inView.map(at));
    expect(people.filter((p) => p.lng <= middle).every((p) => shown.has(at(p)))).toBe(true);
    const margin = (2 * VEHICLES.voyador.length) / 111_320;
    expect(inView.every((p) => p.lng <= middle + margin)).toBe(true);
  });

  it('tows the pagoda with ropes through each column, taut when stretched, slack at rest', () => {
    // Meters east and north of the start, from lng/lat.
    const meters = ([lng, lat]: readonly [number, number]) => [east(lng), lat * 110_540] as const;
    const ropes = (progress: number) =>
      lines(progress).filter((a) => a.line!.paints.includes(Paint.cream) && !a.line!.tip);
    const at = 0.5;
    expect(ropes(at)).toHaveLength(PROCESSION.columns * PROCESSION.ranks);
    // Each ends at a voyador's stern: 6 m (half its length) behind its center.
    const sterns = boats(at)
      .filter((a) => a.vehicle === 'voyador')
      .map((v) => {
        const [x, y] = meters([v.lng, v.lat]);
        const [ax, ay] = meters(v.ahead!);
        return [x - (ax - x) * 6, y - (ay - y) * 6] as const;
      });
    for (const rope of ropes(at)) {
      const [ex, ey] = meters(rope.line!.points.at(-1)!);
      const nearest = Math.min(...sterns.map(([x, y]) => Math.hypot(x - ex, y - ey)));
      expect(nearest).toBeLessThan(0.5);
    }
    // How far a rope bows off its chord, at its middle.
    const bow = (rope: typeof lines extends (...a: never[]) => (infer T)[] ? T : never) => {
      const pts = rope.line!.points.map(meters);
      const [a, b, m] = [pts[0]!, pts.at(-1)!, pts[3]!];
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      return Math.abs((b[0] - a[0]) * (a[1] - m[1]) - (a[0] - m[0]) * (b[1] - a[1])) / d;
    };
    // Each rope, over the run: pulled straight at times, sagging at others.
    const sags: number[][] = [];
    for (let p = 0.2; p <= 0.8; p += 0.01) {
      ropes(p).forEach((rope, i) => (sags[i] ??= []).push(bow(rope)));
    }
    const both = sags.filter((s) => Math.min(...s) < 0.05 && Math.max(...s) > 0.5);
    expect(both.length).toBeGreaterThan(sags.length / 2);
  });

  it('raises striped poles with pennants from the pagoda’s sides', () => {
    const pagoda = boats(0.5).find((a) => a.vehicle === 'pagoda')!;
    const poles = lines(0.5).filter((a) => a.line!.tip);
    expect(poles).toHaveLength(PROCESSION.poles);
    for (const pole of poles) {
      expect(pole.line!.tip!.glyph).toBe('¶');
      expect(pole.line!.paints).toEqual([Paint.yellow, Paint.graphite]);
      const [lng, lat] = pole.line!.points[0]!;
      const d = Math.hypot(east(lng) - east(pagoda.lng), (lat - pagoda.lat) * 110_540);
      expect(d).toBeLessThanOrEqual(
        Math.hypot(VEHICLES.pagoda.length / 2, VEHICLES.pagoda.width / 2) + 0.5,
      );
      // Leaning out past the side.
      const [tl, tt] = pole.line!.points.at(-1)!;
      expect(Math.abs((tt - pagoda.lat) * 110_540)).toBeGreaterThan(VEHICLES.pagoda.width / 2);
      void tl;
    }
  });

  it('seats two files of paddlers in each voyador, in its colors, pulling in time', () => {
    const at = (time: number, crews = true) => scene.agents(0.5, time, { crowds: false, crews });
    const agents = at(0);
    const voyadores = agents.filter((a) => a.vehicle === 'voyador');
    const rowers = agents.filter((a) => a.people?.[0]?.figure === 'rower');
    expect(voyadores.length).toBeGreaterThan(0);
    expect(rowers).toHaveLength(voyadores.length * 2 * PROCESSION.crew.pairs);
    for (const r of rowers) {
      expect(r.aboard).toBe(true);
      expect(VEHICLES.voyador.paints).toContain(r.people![0]!.paint);
    }
    // As many paddling on the left as on the right.
    const left = rowers.filter((r) => r.people![0]!.flap === 0).length;
    expect(left * 2).toBe(rowers.length);
    expect(at(0, false).some((a) => a.people?.[0]?.figure === 'rower')).toBe(false);
    // Each boat's paddlers follow it, all at the same point of the stroke, which comes round.
    const crew = PROCESSION.crew.pairs * 2;
    const strokes = (time: number) => {
      const list = at(time);
      return list.flatMap((a, i) =>
        a.vehicle === 'voyador' ? [list.slice(i + 1, i + 1 + crew).map((r) => r.stroke)] : [],
      );
    };
    for (const boat of strokes(0)) expect(new Set(boat).size).toBe(1);
    const first = (time: number) => strokes(time)[0]![0];
    expect(new Set([0, 0.2, 0.4, 0.6, 0.8].map(first))).toEqual(new Set([0, 1]));
  });

  it('paints its boats in colors that stand out from the water', () => {
    for (const craft of ['pagoda', 'voyador', 'baroto', 'sailboat'] as const) {
      for (const paint of VEHICLES[craft].paints) expect(BOAT_PAINTS_AVOID).not.toContain(paint);
    }
  });
});

describe('motion', () => {
  it('surges and halts, from the start to the end', () => {
    const table = motionProfile(7, 1000);
    expect(table[0]).toBe(0);
    expect(table.at(-1)).toBeCloseTo(1, 12);
    let flat = 0;
    for (let i = 1; i < table.length; i++) {
      expect(table[i]!).toBeGreaterThanOrEqual(table[i - 1]!);
      if (table[i] === table[i - 1]) flat++;
    }
    // At least two halts of 3% or more of the run.
    expect(flat).toBeGreaterThan(0.06 * (table.length - 1) - 2);
    // Surges: the pace varies between halts.
    const steps = Array.from(table.slice(1), (v, i) => v - table[i]!).filter((d) => d > 0);
    expect(Math.max(...steps) / Math.min(...steps)).toBeGreaterThan(1.5);
    expect(profileAt(table, 2)).toBe(1);
  });

  it('sets the lead off first, so the gap to the pagoda stretches and closes', () => {
    const scene = new ProcessionScene(route);
    const gaps: number[] = [];
    for (let p = 0.2; p <= 0.8; p += 0.01) {
      const agents = scene.agents(p, 0, { crowds: false }).filter((a) => !a.line);
      const lead = Math.max(
        ...agents.filter((a) => a.vehicle === 'voyador').map((a) => east(a.lng)),
      );
      gaps.push(lead - east(agents.find((a) => a.vehicle === 'pagoda')!.lng));
    }
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeGreaterThan(2);
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
    const agents = world.visible(16, 1, center).filter((a) => !a.line);
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
