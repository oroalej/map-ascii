import { describe, expect, it } from 'vitest';
import { JunctionTable, compatible, type Movement } from './junctions';
import { LifeBuilder, LifeLine } from './geometry';
import { TileLife, type Mover } from './simulate';
import { continuityMover, continuityTile, left, right } from './testing/continuity';

const life = new TileLife({ z: 16, x: 1, y: 1 }, new LifeBuilder().finish(), 1);
const mover = () => ({ kind: 'vehicle', vehicle: 'car' }) as Mover;
const movement = (ix: number, iy: number, ox: number, oy: number): Movement => ({
  key: 'cross',
  junction: { key: 'cross', x: 0, y: 0, radius: 7, arms: [] },
  inHx: ix,
  inHy: iy,
  outHx: ox,
  outHy: oy,
  stop: 0,
  line: 0,
  dir: 1,
  exit: { line: 1, along: 0, out: 1, hx: ox, hy: oy },
  ahead: 2,
});
const east = movement(1, 0, 1, 0),
  south = movement(0, 1, 0, 1);
it('keeps initial traffic outside ordinary junction reservation zones', () => {
  const b = new LifeBuilder();
  b.line(
    [
      { x: 100, y: 2048 },
      { x: 2048, y: 2048 },
      { x: 3996, y: 2048 },
    ],
    LifeLine.roadMajor,
    8,
  );
  b.line(
    [
      { x: 2048, y: 100 },
      { x: 2048, y: 2048 },
      { x: 2048, y: 3996 },
    ],
    LifeLine.roadMinor,
    6,
  );
  const tile = new TileLife(left, b.finish(), 1);
  const car: Mover = {
    kind: 'vehicle',
    vehicle: 'car',
    line: 0,
    from: 0,
    dir: 1,
    d: 1947,
    x: 2047,
    y: 2048,
    hx: 1,
    hy: 0,
    speed: 5 * tile.perMeter,
    paint: 0,
    lane: 0,
    pause: 0,
    rank: 0,
  };
  expect(tile.junctionIndex.hasLinked).toBe(false);
  expect(tile.junctionIndex.movement(car, 60 * tile.perMeter)!.ahead).toBeLessThan(0);
  expect(tile.junctionIndex.canSpawnVehicle(car)).toBe(false);
  car.d -= 30 * tile.perMeter;
  car.x -= 30 * tile.perMeter;
  expect(tile.junctionIndex.canSpawnVehicle(car)).toBe(true);
  car.d += 30 * tile.perMeter;
  car.x += 30 * tile.perMeter;
  tile.movers.splice(0, tile.movers.length, car);
  let checked = 0;
  tile.settleGround((owner) => {
    if (owner !== car) return true;
    checked++;
    expect(tile.junctionIndex.canSpawnVehicle(car)).toBe(true);
    return true;
  });
  expect(checked).toBeGreaterThan(0);
  expect(tile.movers).toContain(car);
});

describe('junction arbitration', () => {
  it('rebinds a seam hold without releasing its physical box or waiting age', () => {
    const a = continuityTile(left),
      b = continuityTile(right);
    const source = new TileLife(a.tile, a.life, 1),
      target = new TileLife(b.tile, b.life, 2);
    source.movers.splice(0);
    target.movers.splice(0);
    const m = continuityMover(source, 4096.001),
      waiter = mover();
    source.movers.push(m);
    const table = new JunctionTable();
    const box = {
      ...east,
      junction: { ...east.junction, x: 4096, y: m.y, radius: 10 * source.perMeter },
    };
    table.request({
      m,
      life: source,
      tileKey: a.key,
      index: 0,
      movement: box,
      inside: true,
      ready: true,
    });
    table.resolve(1);
    expect(target.adoptFrom(m, source)).toBe(true);
    table.rebind(m, target, b.key, source);
    table.begin(new Set([target]));
    table.refreshCarried(m, () => false, Infinity);
    table.request({
      m: waiter,
      life: target,
      tileKey: b.key,
      index: 1,
      movement: { ...south, junction: { ...box.junction, x: 0 } },
      ready: true,
      inside: false,
    });
    table.resolve(40);
    expect(table.granted(m)).toBe(true);
    expect(table.granted(waiter)).toBe(false);
    expect(table.waited(m)).toBe(39);
    m.x = 20 * target.perMeter;
    table.begin(new Set([target]));
    table.refreshCarried(m, () => false, Infinity);
    table.request({
      m: waiter,
      life: target,
      tileKey: b.key,
      index: 1,
      movement: { ...south, junction: { ...box.junction, x: 0 } },
      ready: true,
      inside: false,
    });
    table.resolve(41);
    expect(table.movement(m)).toBeUndefined();
    expect(table.granted(waiter)).toBe(true);
  });
  it('allows same approaches, opposing through traffic and distinct right turns', () => {
    expect(compatible(east, east)).toBe(true);
    expect(compatible(east, movement(-1, 0, -1, 0))).toBe(true);
    expect(compatible(east, south)).toBe(false);
    expect(compatible(east, movement(0, 1, 1, 0))).toBe(false);
    expect(compatible(movement(1, 0, 0, 1), movement(0, 1, -1, 0))).toBe(true);
  });
  it('breaks arrival ties to the right and ages a conflicting waiter', () => {
    const table = new JunctionTable(),
      a = mover(),
      b = mover();
    const step = (clock: number, includeA = true) => {
      table.begin(new Set([life]));
      table.request({
        m: b,
        life,
        tileKey: 'b',
        index: 0,
        movement: south,
        ready: true,
        inside: false,
        atLine: true,
      });
      if (includeA)
        table.request({
          m: a,
          life,
          tileKey: 'a',
          index: 0,
          movement: east,
          ready: true,
          inside: false,
          atLine: true,
        });
      table.resolve(clock);
    };
    step(0);
    expect(table.granted(a)).toBe(true);
    expect(table.granted(b)).toBe(false);
    step(11);
    expect(table.waited(b)).toBe(11);
    step(12, false);
    expect(table.granted(b)).toBe(true);
    table.begin(new Set());
    expect(table.snapshot()).toEqual([]);
  });
  it('never times out an occupied box or bypasses red after prolonged waiting', () => {
    const table = new JunctionTable(),
      a = mover(),
      b = mover();
    for (const clock of [0, 21, 31, 100]) {
      table.begin(new Set([life]));
      table.request({
        m: a,
        life,
        tileKey: 'a',
        index: 0,
        movement: east,
        ready: true,
        inside: true,
      });
      table.request({
        m: b,
        life,
        tileKey: 'b',
        index: 0,
        movement: south,
        ready: true,
        inside: false,
      });
      table.resolve(clock);
      expect(table.granted(a)).toBe(true);
      expect(table.granted(b)).toBe(false);
    }
    table.begin(new Set([life]));
    table.request({
      m: b,
      life,
      tileKey: 'b',
      index: 0,
      movement: south,
      ready: false,
      inside: false,
    });
    table.resolve(101);
    expect(table.granted(b)).toBe(false);
  });
});
