import { expect, it } from 'vitest';
import { JunctionTable, type Movement } from './junctions';
import { LifeBuilder } from './geometry';
import { TileLife, type Mover } from './simulate';

const movement = (vertical = false): Movement => ({
  key: 'j',
  junction: { key: 'j', x: 0, y: 0, radius: 7, arms: [] },
  inHx: vertical ? 0 : 1,
  inHy: vertical ? 1 : 0,
  outHx: vertical ? 0 : 1,
  outHy: vertical ? 1 : 0,
  rank: 0,
  stop: 0,
  line: 0,
  dir: 1,
  exit: { line: 0, along: 0, out: 1, hx: 1, hy: 0 },
  ahead: 2,
});
const life = new TileLife({ z: 16, x: 1, y: 1 }, new LifeBuilder().finish(), 1);

it('counts only arrival at the stop line, preserving an absent arrival for distant requests', () => {
  const table = new JunctionTable(),
    a = { kind: 'vehicle', vehicle: 'car' } as Mover,
    b = { kind: 'vehicle', vehicle: 'car' } as Mover;
  const request = (m: Mover, atLine?: boolean) =>
    table.request({
      m,
      life,
      tileKey: m === a ? 'a' : 'b',
      index: 0,
      movement: movement(m === a),
      ready: false,
      inside: false,
      atLine,
    });
  request(a);
  table.resolve(0);
  table.begin(new Set([life]));
  request(a);
  request(b, true);
  table.resolve(5);
  expect(table.waited(a)).toBe(0);
  expect(table.snapshot().find((r) => r.tileKey === 'a')!.arrival).toBeUndefined();
  table.begin(new Set([life]));
  request(a, true);
  request(b, true);
  table.resolve(6);
  expect(table.waited(a)).toBe(0);
  expect(table.waited(b)).toBe(1);
});

for (const z of [15, 17])
  it(`uses metres for the three metre threshold and excludes a follower at z${z}`, () => {
    const b = new LifeBuilder();
    b.line(
      [
        { x: 100, y: 2048 },
        { x: 2048, y: 2048 },
        { x: 3996, y: 2048 },
      ],
      0,
      12,
    );
    b.line(
      [
        { x: 2048, y: 100 },
        { x: 2048, y: 2048 },
        { x: 2048, y: 3996 },
      ],
      0,
      12,
    );
    const tile = new TileLife({ z, x: 1, y: 1 }, b.finish(), 1),
      pm = tile.perMeter;
    tile.movers.length = 0;
    const car = (ahead: number): Mover => ({
      kind: 'vehicle',
      vehicle: 'car',
      line: 0,
      from: 0,
      dir: 1,
      d: 1948 - (10.7 + ahead) * pm,
      x: 2048 - (10.7 + ahead) * pm,
      y: 2048,
      hx: 1,
      hy: 0,
      speed: 0,
      paint: 0,
      lane: 0,
      pause: 0,
      rank: 0,
    });
    const first = car(2),
      follower = car(2.8),
      distant = car(3.1),
      table = new JunctionTable();
    tile.movers.push(first, follower, distant);
    tile.prepareTraffic(() => true);
    tile.requestJunctions(table, () => true, 0);
    table.resolve(0);
    expect(table.snapshot().find((r) => r.index === 0)!.arrival).toBe(0);
    expect(table.snapshot().find((r) => r.index === 1)!.arrival).toBeUndefined();
    expect(table.snapshot().find((r) => r.index === 2)!.arrival).toBeUndefined();
  });
