import { expect, it } from 'vitest';
import type { SignalArm } from '@atlas/shared';
import { LifeBuilder, LifeLine, type LifeGeometry } from './geometry';
import { hashString, lngLatToTile, metersPerUnit, tileToLngLat } from '../raster/geometry';
import { signalApproaches } from './signal-approaches';
import { TileLife, type Mover } from './simulate';
import { signalState } from './signals';
import { VEHICLES } from './vehicles';

const tile = { z: 16, x: 55194, y: 30264 },
  pm = 1 / metersPerUnit(tile),
  p = { x: 2000, y: 2000 };
const points = [
  { x: p.x - 2 * pm, y: p.y + 80 * pm },
  { x: p.x - 2 * pm, y: p.y },
  p,
  { x: p.x + 2 * pm, y: p.y },
  { x: p.x + 2 * pm, y: p.y - 80 * pm },
];
const stations = (geo: LifeGeometry) => {
  const along = new Float64Array(geo.coords.length / 2);
  for (let line = 0; line < geo.kinds.length; line++)
    for (let v = geo.starts[line]! + 1; v < geo.starts[line + 1]!; v++)
      along[v] =
        along[v - 1]! +
        Math.hypot(
          geo.coords[v * 2]! - geo.coords[(v - 1) * 2]!,
          geo.coords[v * 2 + 1]! - geo.coords[(v - 1) * 2 + 1]!,
        );
  return along;
};
function arms(): SignalArm[] {
  return [-1, 1].map((out) => ({
    road_id: 'bent',
    junction: tileToLngLat(tile, p),
    toward: tileToLngLat(tile, points[out === 1 ? 3 : 1]!),
    direction: -out as 1 | -1,
    inbound: true,
    outbound: true,
    group: 'a',
    bearing: out === 1 ? 270 : 90,
    width: 10,
    stop: tileToLngLat(tile, { x: p.x - out * 0.5 * pm, y: p.y - out * 9 * pm }),
    stop_width: 5,
    stop_bearing: out === 1 ? 180 : 0,
  }));
}
function fixture(legacy = false, remote = false) {
  const b = new LifeBuilder(),
    records = arms();
  b.line(remote ? points.slice(3) : points, LifeLine.roadMid, 10, hashString('bent'));
  b.signal(
    p,
    6,
    legacy ? -1 : 90,
    0,
    true,
    legacy ? undefined : { members: [tileToLngLat(tile, p)], arms: records },
    { seed: 0, stops: legacy ? records : undefined },
  );
  const geo = b.finish(),
    life = new TileLife(tile, geo, 1);
  life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
  life.scenes.sites.length = 0;
  return { geo, life, records, along: stations(geo) };
}

it('recovers laterally offset stops and projects accumulated stations beyond bends in both directions', () => {
  const { geo, along, records } = fixture();
  const approaches = signalApproaches(
    tile,
    geo,
    { members: [tileToLngLat(tile, p)], arms: records },
    along,
  );
  expect(approaches).toHaveLength(2);
  for (const approach of approaches)
    expect((approach.stopAlong! - along[2]!) / pm).toBeCloseTo(approach.out * 11, 4);
  const remote = fixture(false, true);
  expect(
    signalApproaches(tile, remote.geo, { members: [], arms: remote.records }, remote.along),
  ).toHaveLength(0);
  const localStops = signalApproaches(
    tile,
    remote.geo,
    { members: [], arms: remote.records },
    remote.along,
    true,
  );
  expect(localStops).toHaveLength(1);
  expect(localStops[0]!.stopAlong! / pm).toBeCloseTo(9, 4);
});

it('stops actual layout and legacy vehicle fronts behind the selected bands, then releases on green', () => {
  for (const legacy of [false, true])
    for (const dir of [-1, 1] as const) {
      const { life, records } = fixture(legacy),
        arm = records.find((a) => a.direction === dir)!;
      const from = dir === 1 ? 0 : 4,
        toward = from + dir;
      const dx = points[toward]!.x - points[from]!.x,
        dy = points[toward]!.y - points[from]!.y,
        length = Math.hypot(dx, dy);
      const m: Mover = {
        kind: 'vehicle',
        vehicle: 'car',
        line: 0,
        from,
        dir,
        d: 0,
        speed: 6 * pm,
        v: 6 * pm,
        pause: 0,
        rank: 0,
        paint: 0,
        lane: 0.5,
        x: points[from]!.x,
        y: points[from]!.y,
        hx: dx / length,
        hy: dy / length,
      };
      life.movers.push(m);
      const seed = life.signals.signals[0]!.seed;
      const red = Array.from({ length: 200 }, (_, i) => i).find(
        (t) => signalState(seed, t, legacy).a === 'red',
      )!;
      const green = Array.from({ length: 200 }, (_, i) => i).find(
        (t) => signalState(seed, t, legacy).a === 'green',
      )!;
      for (let i = 0; i < 500; i++)
        life.step(0.05, undefined, undefined, undefined, { rain: 0, clock: red });
      const stop = lngLatToTile(tile, ...arm.stop!),
        hx = Math.sin((arm.stop_bearing! * Math.PI) / 180),
        hy = -Math.cos((arm.stop_bearing! * Math.PI) / 180);
      const front = {
        x: m.x + (hx * VEHICLES.car.length * pm) / 2,
        y: m.y + (hy * VEHICLES.car.length * pm) / 2,
      };
      expect(((stop.x - front.x) * hx + (stop.y - front.y) * hy) / pm).toBeGreaterThanOrEqual(
        -0.01,
      );
      // The vehicle rests with its front at the exact stop position.
      expect(m.v! / pm).toBeLessThan(0.1);
      const before = { x: m.x, y: m.y };
      for (let i = 0; i < 120; i++)
        life.step(1 / 60, undefined, undefined, undefined, { rain: 0, clock: green });
      expect(Math.hypot(m.x - before.x, m.y - before.y) / pm).toBeGreaterThan(1);
    }
});

it('uses exact mid-block group a stops for east-west and north-south approaches', () => {
  for (const bearing of [0, 90])
    for (const dir of [-1, 1] as const) {
      const b = new LifeBuilder(),
        theta = (bearing * Math.PI) / 180,
        hx = Math.sin(theta),
        hy = -Math.cos(theta);
      const start = { x: p.x - hx * 50 * pm, y: p.y - hy * 50 * pm },
        end = { x: p.x + hx * 50 * pm, y: p.y + hy * 50 * pm };
      b.line([start, p, end], LifeLine.roadMid, 10, hashString('mid'));
      const stop = {
        x: p.x - dir * hx * 7 * pm - dir * hy * 2.5 * pm,
        y: p.y - dir * hy * 7 * pm + dir * hx * 2.5 * pm,
      };
      b.signal(p, 4, -1, 90, true, undefined, {
        seed: 0,
        stops: [
          {
            road_id: 'mid',
            junction: tileToLngLat(tile, p),
            toward: tileToLngLat(tile, dir === 1 ? start : end),
            direction: dir,
            inbound: true,
            outbound: true,
            group: 'a',
            bearing: (bearing + (dir === 1 ? 0 : 180)) % 360,
            width: 10,
            stop: tileToLngLat(tile, stop),
            stop_width: 5,
            stop_bearing: (bearing + (dir === 1 ? 0 : 180)) % 360,
          },
        ],
      });
      const life = new TileLife(tile, b.finish(), 1);
      const m: Mover = {
        kind: 'vehicle',
        vehicle: 'car',
        line: 0,
        from: dir === 1 ? 0 : 2,
        dir,
        d: 43 * pm - (VEHICLES.car.length / 2) * pm,
        speed: 6 * pm,
        v: 0,
        pause: 0,
        rank: 0,
        paint: 0,
        lane: 0.5,
        x: stop.x,
        y: stop.y,
        hx: dir * hx,
        hy: dir * hy,
      };
      expect(life.signals.vehicleSpeed(m, 0.1, 46) / pm).toBeLessThan(0.001);
      expect(life.signals.vehicleSpeed(m, 0.1, 0)).toBe(m.speed);
    }
});

it('controls the exact stop on a wider reversed continuation while retaining the original head arm', () => {
  for (const reversed of [false, true]) {
    const at = (x: number, y = 0) => ({ x: p.x + x * pm, y: p.y + y * pm });
    const b = new LifeBuilder();
    b.line([p, at(3)], LifeLine.roadMid, 10, hashString('original'));
    b.line(
      reversed ? [at(100), at(3)] : [at(3), at(100)],
      LifeLine.roadMid,
      14,
      hashString('continuation'),
    );
    const arm: SignalArm = {
      ...arms()[0]!,
      road_id: 'original',
      junction: tileToLngLat(tile, p),
      toward: tileToLngLat(tile, at(3)),
      direction: -1,
      bearing: 270,
      stop: tileToLngLat(tile, at(13, -3.5)),
      stop_bearing: 270,
      stop_width: 7,
      stop_road_id: 'continuation',
      stop_direction: reversed ? 1 : -1,
      stop_road_width: 14,
    };
    // East-west inbound paint lies north in geographic coordinates, negative tile y.
    b.signal(p, 6, 90, 0, true, { members: [arm.junction], arms: [arm] }, { seed: 0 });
    const life = new TileLife(tile, b.finish(), 1);
    life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
    const stops = life.signals.signals[0]!.approaches!.filter((a) => a.stopAlong !== undefined);
    expect(stops).toHaveLength(1);
    expect(stops[0]!.line).toBe(1);
    expect(stops[0]!.arm.road_id).toBe('original');
    const m: Mover = {
      kind: 'vehicle',
      vehicle: 'car',
      line: 1,
      from: reversed ? 2 : 3,
      dir: reversed ? 1 : -1,
      d: (100 - 13 - VEHICLES.car.length / 2) * pm,
      speed: 6 * pm,
      v: 0,
      pause: 0,
      rank: 0,
      paint: 0,
      lane: 0.5,
      x: at(13 + VEHICLES.car.length / 2).x,
      y: p.y,
      hx: -1,
      hy: 0,
    };
    const red = Array.from({ length: 200 }, (_, i) => i).find(
      (t) => signalState(0, t, false).a === 'red',
    )!;
    const green = Array.from({ length: 200 }, (_, i) => i).find(
      (t) => signalState(0, t, false).a === 'green',
    )!;
    expect(life.signals.vehicleSpeed(m, 0.1, red) / pm).toBeLessThan(0.001);
    expect(life.signals.vehicleSpeed(m, 0.1, green)).toBe(m.speed);
  }
});
