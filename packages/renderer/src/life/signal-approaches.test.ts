import { describe, expect, it } from 'vitest';
import type { SignalArm, SignalLayout } from '@atlas/shared';
import { hashString, metersPerUnit, tileToLngLat, lngLatToTile } from '../raster/geometry';
import { LifeBuilder, LifeLine } from './geometry';
import { tileFixtures } from './fixtures';
import { TileLife, type Mover } from './simulate';
import { signalState } from './signals';
import { JunctionTable, compatible } from './junctions';
import { ROAD_SPLIT_CLEARANCE_M } from './config';

const tile = { z: 16, x: 55194, y: 30264 },
  pm = 1 / metersPerUnit(tile);
function fixture(oneway = false, simplified = false) {
  const p = { x: 1800, y: 2000 },
    q = { x: 1800 + 12 * pm, y: 2000 };
  const lines = [
    [{ x: p.x - 100 * pm, y: p.y }, p],
    [p, q, { x: q.x + 100 * pm, y: q.y }],
    [{ x: p.x, y: p.y + 100 * pm }, p],
    [q, { x: q.x, y: q.y - 100 * pm }],
  ];
  const builder = new LifeBuilder();
  for (const [i, line] of lines.entries())
    builder.line(
      simplified && i === 1 ? [line[0]!, line[2]!] : line,
      LifeLine.roadMid,
      10,
      hashString(`road/${i}`),
      oneway ? 1 : 0,
    );
  const arm = (line: number, vertex: number, out: 1 | -1, group: 'a' | 'b'): SignalArm => {
    const at = lines[line]![vertex]!,
      toward = lines[line]![vertex + out]!;
    const dx = toward.x - at.x,
      dy = toward.y - at.y,
      len = Math.hypot(dx, dy),
      hx = dx / len,
      hy = dy / len;
    const inbound = !oneway || out === -1;
    return {
      road_id: `road/${line}`,
      junction: tileToLngLat(tile, at),
      toward: tileToLngLat(tile, toward),
      direction: -out as 1 | -1,
      inbound,
      outbound: !oneway || out === 1,
      group,
      bearing: ((Math.atan2(-hx, hy) * 180) / Math.PI + 360) % 360,
      width: 10,
      ...(inbound
        ? {
            stop: tileToLngLat(tile, { x: at.x + hx * 7.5 * pm, y: at.y + hy * 7.5 * pm }),
            stop_width: oneway ? 10 : 5,
          }
        : {}),
    };
  };
  const layout: SignalLayout = {
    members: [tileToLngLat(tile, p), tileToLngLat(tile, q)],
    arms: [arm(0, 1, -1, 'a'), arm(1, 1, 1, 'a'), arm(2, 1, -1, 'b'), arm(3, 0, 1, 'b')],
  };
  builder.signal(p, 6, 90, 0, true, layout);
  builder.splitSignalRoads((p) => lngLatToTile(tile, ...p), hashString);
  const geo = builder.finish(),
    life = new TileLife(tile, geo, 1);
  life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
  life.scenes.sites.length = 0;
  function car(original: number): Mover {
    const a = layout.arms.find((a) => a.road_id === `road/${original}`)!,
      dir = a.direction;
    const targetPoint = lngLatToTile(tile, ...a.junction);
    const line = Array.from(geo.lineIds!).findIndex((id, i) => {
      if (id !== hashString(a.road_id)) return false;
      const vertex = dir === 1 ? geo.starts[i + 1]! - 1 : geo.starts[i]!;
      return (
        Math.hypot(
          geo.coords[vertex * 2]! - targetPoint.x,
          geo.coords[vertex * 2 + 1]! - targetPoint.y,
        ) < 2
      );
    });
    const first = geo.starts[line]!,
      last = geo.starts[line + 1]! - 1;
    const from = dir === 1 ? first : last;
    const target = lngLatToTile(tile, ...a.junction),
      outer = lines[original]![dir === 1 ? 0 : lines[original]!.length - 1]!;
    const length = Math.hypot(target.x - outer.x, target.y - outer.y),
      hx = (target.x - outer.x) / length,
      hy = (target.y - outer.y) / length;
    return {
      kind: 'vehicle',
      vehicle: 'car',
      line,
      from,
      dir,
      d: 80 * pm,
      x: outer.x + hx * 80 * pm,
      y: outer.y + hy * 80 * pm,
      hx,
      hy,
      speed: 8 * pm,
      v: 0,
      paint: 0,
      lane: 0,
      pause: 0,
      rank: 0,
    };
  }
  return { p, q, geo, life, layout, car };
}
const clockFor = (life: TileLife, group: 'a' | 'b', color: 'green' | 'red' | 'amber') =>
  Array.from({ length: 140 }, (_, t) => t).find(
    (t) => signalState(life.signals.signals[0]!.seed, t)[group] === color,
  )!;

describe('authoritative signal approaches', () => {
  for (const authorized of [false, true])
    it(`${authorized ? 'clears earned green entry' : 'holds newly adopted traffic'} just past an unlinked red painted stop`, () => {
      const b = new LifeBuilder(),
        center = { x: 2000, y: 2000 };
      b.line(
        [{ x: center.x - 100 * pm, y: center.y }, center, { x: center.x + 100 * pm, y: center.y }],
        LifeLine.roadMajor,
        10,
        hashString('single/0'),
      );
      b.line(
        [{ x: center.x, y: center.y - 100 * pm }, center, { x: center.x, y: center.y + 100 * pm }],
        LifeLine.roadMajor,
        10,
        hashString('single/1'),
      );
      const layout: SignalLayout = {
        members: [tileToLngLat(tile, center)],
        arms: [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
        ].map(([hx, hy], i) => ({
          road_id: `single/${i < 2 ? 0 : 1}`,
          junction: tileToLngLat(tile, center),
          toward: tileToLngLat(tile, {
            x: center.x + hx! * 100 * pm,
            y: center.y + hy! * 100 * pm,
          }),
          direction: i % 2 === 0 ? 1 : -1,
          inbound: true,
          outbound: true,
          group: i < 2 ? ('a' as const) : ('b' as const),
          bearing: ((Math.atan2(-hx!, hy!) * 180) / Math.PI + 360) % 360,
          width: 10,
          stop: tileToLngLat(tile, { x: center.x + hx! * 10 * pm, y: center.y + hy! * 10 * pm }),
          stop_width: 5,
        })),
      };
      b.signal(center, 6, 90, 0, true, layout);
      b.splitSignalRoads((p) => lngLatToTile(tile, ...p), hashString);
      const life = new TileLife(tile, b.finish(), 1),
        table = new JunctionTable();
      life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
      life.scenes.sites.length = 0;
      const m: Mover = {
        kind: 'vehicle',
        vehicle: 'car',
        line: 0,
        from: 0,
        dir: 1,
        d: 80 * pm,
        x: center.x - 20 * pm,
        y: center.y,
        hx: 1,
        hy: 0,
        speed: 8 * pm,
        v: 0,
        paint: 0,
        lane: 0,
        pause: 0,
        rank: 0,
        next: 2,
      };
      life.movers.push(m);
      const movement = life.junctionIndex.movement(m, 60 * pm)!;
      expect(movement.junction.linked).toBe(false);
      expect(movement.junction.controlled).toBe(true);
      if (authorized) {
        const green = clockFor(life, 'a', 'green');
        life.prepareTraffic(() => true);
        table.begin(new Set([life]));
        life.requestJunctions(table, () => true, green);
        table.resolve(green);
        expect(table.granted(m)).toBe(true);
      }
      const distance = movement.ahead + 0.1 * pm;
      m.d += distance;
      m.x += distance;
      expect(life.junctionIndex.canSpawnVehicle(m)).toBe(false);
      const red = clockFor(life, 'a', 'red');
      life.prepareTraffic(() => true);
      table.begin(new Set([life]));
      life.requestJunctions(table, () => true, red);
      table.resolve(red);
      expect(table.snapshot()[0]!.inside).toBe(true);
      const x = m.x;
      life.step(0.1, undefined, undefined, undefined, { clock: red, rain: 0 }, undefined, {
        junctions: table,
      });
      if (authorized) expect(m.x).toBeGreaterThan(x);
      else expect(m.x).toBe(x);
      Object.assign(m, {
        line: movement.exit.line,
        from: life.geo.starts[movement.exit.line]!,
        dir: 1,
        d: 25 * pm,
        x: center.x + 25 * pm,
      });
      expect(life.junctionIndex.canSpawnVehicle(m)).toBe(true);
    });
  it('varies the first linked-route fallback across bicycle ranks deterministically', () => {
    const route = (rank: number) => {
      const { life, car } = fixture();
      const m = car(0);
      m.vehicle = 'bicycle';
      m.rank = rank;
      expect(m.next).toBeUndefined();
      expect(m.routing?.plan).toBeUndefined();
      // Isolate the fallback: ordinary traffic preparation preselects the connector.
      (life as unknown as { prepareSignalRoute(m: Mover): void }).prepareSignalRoute(m);
      const first = m.junctionRoute?.exits[0];
      expect(first).toBeDefined();
      const line = first! >> 1;
      const dir = first! & 1 ? -1 : 1;
      const flow = life.geo.oneway?.[line];
      expect(!flow || flow === dir).toBe(true);
      const from = dir === 1 ? life.geo.starts[line]! : life.geo.starts[line + 1]! - 1;
      expect(
        Math.hypot(life.geo.coords[from * 2]! - 1800, life.geo.coords[from * 2 + 1]! - 2000),
      ).toBeLessThan(2);
      return first!;
    };
    const exits = Array.from({ length: 12 }, (_, i) => route(i / 12));
    expect(new Set(exits).size).toBe(2);
    expect(route(5 / 12)).toBe(exits[5]);
  });
  it('varies the final linked-signal exit per bicycle while retaining a forced connector', () => {
    const route = (rank: number) => {
      const { life, geo, p, q, car } = fixture();
      const connector = Array.from(geo.lineIds!).findIndex((id, line) => {
        const first = geo.starts[line]!,
          last = geo.starts[line + 1]! - 1;
        return (
          id === hashString('road/1') &&
          Math.hypot(geo.coords[first * 2]! - p.x, geo.coords[first * 2 + 1]! - p.y) < 2 &&
          Math.hypot(geo.coords[last * 2]! - q.x, geo.coords[last * 2 + 1]! - q.y) < 2
        );
      });
      expect(connector).toBeGreaterThanOrEqual(0);
      const m = car(0);
      m.vehicle = 'bicycle';
      m.rank = rank;
      m.next = connector * 2;
      life.movers.push(m);
      life.prepareTraffic(() => true);
      expect(m.junctionRoute?.exits[0]).toBe(connector * 2);
      const final = m.junctionRoute?.exits.at(-1);
      expect(final).toBeDefined();
      const arm = life.junctionIndex.junctions[0]!.arms.find(
        (a) => a.line === final! >> 1 && a.out === (final! & 1 ? -1 : 1),
      );
      expect(arm?.outbound).not.toBe(false);
      expect(arm).toBeDefined();
      return final!;
    };
    const exits = Array.from({ length: 12 }, (_, i) => route(i / 12));
    expect(new Set(exits).size).toBe(2);
    expect(route(5 / 12)).toBe(exits[5]);
  });
  it('retains red-light braking when a shared road vertex is just beyond the old split clearance', () => {
    const builder = () => {
      const b = new LifeBuilder();
      const y = 2000,
        center = 2000,
        junction = center - 47 * pm;
      b.line(
        [
          { x: center - 100 * pm, y },
          { x: junction, y },
          { x: center, y },
          { x: center + 100 * pm, y },
        ],
        LifeLine.roadMid,
        10,
        77,
      );
      b.line(
        [
          { x: junction, y },
          { x: junction, y: y + 100 * pm },
        ],
        LifeLine.roadMinor,
        6,
        88,
      );
      b.signal({ x: center, y }, 6, 90, 0, true);
      return b;
    };
    const before = new TileLife(tile, builder().finish(), 1);
    const b = builder();
    b.splitRoadJunctions(pm, ROAD_SPLIT_CLEARANCE_M);
    const after = new TileLife(tile, b.finish(), 1);
    const m: Mover = {
      kind: 'vehicle',
      vehicle: 'bus',
      line: 0,
      from: 0,
      dir: 1,
      d: 50 * pm,
      x: 2000 - 50 * pm,
      y: 2000,
      hx: 1,
      hy: 0,
      speed: 20 * pm,
      v: 20 * pm,
      paint: 0,
      lane: 0,
      pause: 0,
      rank: 0,
    };
    const red = clockFor(before, 'a', 'red');
    const limit = before.signals.vehicleSpeed(m, 1 / 30, red);
    expect(limit).toBeLessThan(m.speed);
    expect(after.geo.kinds).toHaveLength(before.geo.kinds.length);
    expect(after.signals.vehicleSpeed(m, 1 / 30, red)).toBeCloseTo(limit);
  });
  it('restores a shared through-road vertex removed by tile simplification', () => {
    const { life, car, q } = fixture(false, true);
    expect(life.signals.signals[0]!.approaches).toHaveLength(4);
    expect(life.junctionIndex.junctions[0]!.arms).toHaveLength(4);
    expect(life.signals.allows(car(3), q.x, q.y, clockFor(life, 'b', 'red'), 10 * pm)).toBe(false);
  });
  it('spawns linked-junction traffic outside the shared reservation zone', () => {
    const { geo, p, q } = fixture();
    const internal = Array.from(geo.kinds).findIndex((_, line) => {
      const a = geo.starts[line]!,
        b = geo.starts[line + 1]! - 1;
      return (
        Math.hypot(geo.coords[a * 2]! - p.x, geo.coords[a * 2 + 1]! - p.y) < 2 &&
        Math.hypot(geo.coords[b * 2]! - q.x, geo.coords[b * 2 + 1]! - q.y) < 2
      );
    });
    expect(internal).toBeGreaterThanOrEqual(0);
    let vehicles = 0;
    for (let seed = 0; seed < 20; seed++) {
      const life = new TileLife(tile, geo, seed);
      for (const m of life.movers.filter((m) => m.kind === 'vehicle')) {
        vehicles++;
        expect(m.line).not.toBe(internal);
        const movement = life.junctionIndex.movement(m, 60 * pm);
        if (movement?.junction.linked) expect(movement.ahead).toBeGreaterThanOrEqual(0);
      }
    }
    expect(vehicles).toBeGreaterThan(0);
  });
  it('draws only inbound heads with actual bearings and retains legacy archives', () => {
    const { geo, layout } = fixture(true);
    const heads = tileFixtures(tile, geo).filter((f) => f.kind === 'signal');
    expect(heads).toHaveLength(2);
    for (const [i, arm] of layout.arms.filter((a) => a.inbound).entries()) {
      const head = heads[i]!;
      const base = lngLatToTile(tile, ...head.base),
        right = lngLatToTile(tile, ...head.right);
      const bearing =
        ((Math.atan2(right.x - base.x, -right.y + base.y) * 180) / Math.PI + 360) % 360;
      expect(bearing).toBeCloseTo((arm.bearing + 180) % 360, 5);
    }
    geo.signalLayouts = undefined;
    expect(tileFixtures(tile, geo).filter((f) => f.kind === 'signal')).toHaveLength(4);
  });
  it('stops both offset side streets on their shared red, regardless of current visual heading', () => {
    const { life, car, p, q } = fixture();
    const red = clockFor(life, 'b', 'red'),
      green = clockFor(life, 'b', 'green');
    for (const [line, point] of [
      [2, p],
      [3, q],
    ] as const) {
      const m = car(line);
      m.hx = 1;
      m.hy = 0;
      expect(life.signals.allows(m, point.x, point.y, red, 10 * pm)).toBe(false);
      expect(life.signals.allows(m, point.x, point.y, green, 10 * pm)).toBe(true);
      expect(life.signals.vehicleSpeed(m, 1 / 60, red)).toBeLessThan(m.speed);
    }
  });
  it('matches the front bumper to the painted stop and leaves outgoing traffic ungated', () => {
    const { life, car, layout } = fixture();
    const m = car(3),
      red = clockFor(life, 'b', 'red');
    life.movers.push(m);
    const stop = lngLatToTile(tile, ...layout.arms[3]!.stop!);
    for (let i = 0; i < 400; i++)
      life.step(0.05, undefined, undefined, undefined, { rain: 0, clock: red });
    expect((stop.y - m.y) / pm).toBeCloseTo(2.2, 1);
    const out = { ...m, from: life.geo.starts[m.line]!, dir: 1 as const, d: 0 };
    expect(life.signals.vehicleSpeed(out, 1 / 60, red)).toBe(out.speed);
  });
  it('shares one reservation zone, excludes internal gates, and clears after green turns red', () => {
    const { life, car, p, q } = fixture();
    expect(life.junctionIndex.junctions).toHaveLength(1);
    const m = car(0);
    m.routing = { seed: 1, turns: 0, plan: { line: 0, dir: 1, vertex: 1, exit: 2, radius: 6 } };
    life.movers.push(m);
    const green = clockFor(life, 'a', 'green'),
      red = clockFor(life, 'a', 'red');
    const table = new JunctionTable();
    for (let frame = 0; frame < 240; frame++) {
      const clock = m.x < p.x - 5 * pm ? green : red;
      life.prepareTraffic(() => true);
      table.begin(new Set([life]));
      life.requestJunctions(table, () => true, clock);
      table.resolve(clock);
      life.step(0.05, undefined, undefined, undefined, { rain: 0, clock }, undefined, {
        junctions: table,
      });
    }
    expect(
      Math.min(Math.hypot(m.x - p.x, m.y - p.y), Math.hypot(m.x - q.x, m.y - q.y)),
    ).toBeGreaterThan(15 * pm);
    expect(m.line).not.toBe(1);
    const north = life.junctionIndex.movement(car(3), 60 * pm)!;
    const south = life.junctionIndex.movement(car(2), 60 * pm)!;
    expect(north.key).toBe(south.key);
    expect(compatible(north, south)).toBe(false);
  });
  it('holds amber when it can brake and clears walkers already inside either member', () => {
    const { life, car, p, q } = fixture();
    const m = car(3),
      amber = clockFor(life, 'b', 'amber');
    expect(life.signals.allows(m, q.x, q.y, amber, 10 * pm)).toBe(false);
    m.v = 30 * pm;
    expect(life.signals.allows(m, q.x, q.y, amber, pm)).toBe(true);
    const red = clockFor(life, 'b', 'red');
    expect(life.signals.walkDistance(p, q, 12 * pm, red)).toBe(12 * pm);
  });
  it('waits for room on the final exit beyond the linked junction', () => {
    const { life, car } = fixture();
    const m = car(0);
    life.movers.push(m);
    life.prepareTraffic(() => true);
    const movement = life.junctionIndex.movement(m, 60 * pm)!;
    expect(m.junctionRoute?.exits.length).toBeGreaterThan(0);
    const exit = movement.exit;
    const blocker = {
      ...car(0),
      line: exit.line,
      dir: exit.out,
      from: exit.out === 1 ? life.geo.starts[exit.line]! : life.geo.starts[exit.line + 1]! - 1,
      d: 8 * pm,
      v: 0,
      speed: 0,
      x: exit.x! + exit.hx * 8 * pm,
      y: exit.y! + exit.hy * 8 * pm,
      hx: exit.hx,
      hy: exit.hy,
    };
    life.movers.push(blocker);
    const table = new JunctionTable(),
      green = clockFor(life, 'a', 'green');
    life.prepareTraffic(() => true);
    table.begin(new Set([life]));
    life.requestJunctions(table, () => true, green);
    table.resolve(green);
    expect(table.granted(m)).toBe(false);
    life.movers.pop();
    life.prepareTraffic(() => true);
    table.begin(new Set([life]));
    life.requestJunctions(table, () => true, green);
    table.resolve(green);
    expect(table.granted(m)).toBe(true);
  });
  it('routes the offset side street onto the main road after green rather than reversing', () => {
    const { life, car, p, q } = fixture();
    const m = car(3),
      initial = m.line;
    life.movers.push(m);
    const green = clockFor(life, 'b', 'green');
    for (let i = 0; i < 300; i++)
      life.step(0.05, undefined, undefined, undefined, { rain: 0, clock: green });
    expect(m.line).not.toBe(initial);
    expect(
      Math.min(Math.hypot(m.x - p.x, m.y - p.y), Math.hypot(m.x - q.x, m.y - q.y)),
    ).toBeGreaterThan(15 * pm);
  });
  it('retains approach matching and phases in a buffered neighbor tile without duplicate heads', () => {
    const { geo, life, car, q } = fixture();
    const neighbor = { ...tile, x: tile.x + 1 };
    const copy = {
      ...geo,
      coords: Float32Array.from(geo.coords, (n, i) => (i % 2 === 0 ? n - 4096 : n)),
      signals: Float32Array.from(geo.signals!, (n, i) => (i % 6 === 0 ? n - 4096 : n)),
    };
    const other = new TileLife(neighbor, copy, 2);
    expect(other.signals.signals[0]!.seed).toBe(life.signals.signals[0]!.seed);
    expect(other.junctionIndex.junctions[0]!.key).toBe(life.junctionIndex.junctions[0]!.key);
    expect(tileFixtures(neighbor, copy).filter((f) => f.kind === 'signal')).toHaveLength(0);
    const m = car(3);
    expect(
      other.signals.allows(
        { ...m, x: m.x - 4096 },
        q.x - 4096,
        q.y,
        clockFor(life, 'b', 'red'),
        10 * pm,
      ),
    ).toBe(false);
  });
});
