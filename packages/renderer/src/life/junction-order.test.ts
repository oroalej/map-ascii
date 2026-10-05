import { expect, it } from 'vitest';
import { compatible, fromRight, JunctionTable, type Movement } from './junctions';
import { LifeBuilder } from './geometry';
import { TileLife, type Mover } from './simulate';

const life = new TileLife({ z: 16, x: 1, y: 1 }, new LifeBuilder().finish(), 1);
const movement = (ix: number, iy: number, ox = ix, oy = iy): Movement => ({
  key: 'j',
  junction: { key: 'j', x: 0, y: 0, radius: 7, arms: [] },
  inHx: ix,
  inHy: iy,
  outHx: ox,
  outHy: oy,
  stop: 0,
  line: 0,
  dir: 1,
  exit: { line: 0, along: 0, out: 1, hx: ox, hy: oy },
  ahead: 2,
});
function harness(paths: Movement[]) {
  const table = new JunctionTable(),
    cars = paths.map(() => ({ kind: 'vehicle', vehicle: 'car' }) as Mover);
  return {
    table,
    cars,
    step(
      clock: number,
      order = paths.map((_, i) => i),
      ready = paths.map(() => true),
      atLine = true,
    ) {
      table.begin(new Set([life]));
      for (const i of order)
        table.request({
          m: cars[i]!,
          life,
          tileKey: String(i),
          index: i,
          movement: paths[i]!,
          ready: ready[i]!,
          inside: false,
          atLine,
        });
      table.resolve(clock);
    },
    winners() {
      return cars.map((m, i) => (table.granted(m) ? i : -1)).filter((i) => i >= 0);
    },
  };
}

it('pins northbound yielding to westbound on its right', () => {
  const north = movement(0, -1),
    west = movement(-1, 0);
  expect(fromRight(north, west)).toBe(true);
  expect(fromRight(west, north)).toBe(false);
  const h = harness([north, west]);
  h.step(0);
  expect(h.winners()).toEqual([1]);
});
it('anchors a tie across 0.99/1.01 without clock buckets', () => {
  const h = harness([movement(0, -1), movement(-1, 0)]);
  h.step(0.99, [0], [false, true]);
  h.step(1.01);
  expect(h.winners()).toEqual([1]);
});
it('gives all four simultaneous arrivals the same cycle break in every permutation', () => {
  const paths = [movement(1, 0), movement(0, 1), movement(-1, 0), movement(0, -1)];
  const permutations = (xs: number[]): number[][] =>
    xs.length
      ? xs.flatMap((x, i) => permutations(xs.filter((_, j) => i !== j)).map((rest) => [x, ...rest]))
      : [[]];
  for (const order of permutations([0, 1, 2, 3])) {
    const h = harness(paths);
    h.step(0, order);
    expect(h.winners()).toEqual([0]);
    let remaining = [1, 2, 3];
    for (let clock = 1; remaining.length; clock++) {
      h.step(clock, remaining);
      expect(h.winners().length).toBeGreaterThan(0);
      remaining = remaining.filter((i) => !h.table.granted(h.cars[i]!));
    }
  }
});
it('preserves precedence outside a cyclic component', () => {
  const h = harness([
    movement(1, 0),
    movement(0, 1),
    movement(-1, 0),
    movement(0, -1),
    movement(1, 0),
  ]);
  h.step(0, [4, 3, 2, 1, 0]);
  for (const a of h.winners())
    for (const b of h.winners())
      expect(compatible(h.table.movement(h.cars[a]!)!, h.table.movement(h.cars[b]!)!)).toBe(true);
  expect(h.winners()).toContain(0);
});
for (const provisional of [false, true])
  it(`processes oncoming before an earlier left turn (provisional=${provisional})`, () => {
    const h = harness([movement(1, 0, 0, -1), movement(-1, 0)]);
    h.step(0, [0], [provisional, true]);
    h.step(2);
    expect(h.winners()).toEqual([1]);
    expect(h.table.waited(h.cars[0]!)).toBe(2);
  });
it('does not yield to red or pedestrian-blocked oncoming traffic', () => {
  const h = harness([movement(1, 0, 0, -1), movement(-1, 0)]);
  h.step(0, [0, 1], [true, false]);
  expect(h.winners()).toEqual([0]);
});
it('does not let an unready yielded left turn block a compatible oncoming follower', () => {
  const h = harness([movement(1, 0, 0, -1), movement(-1, 0), movement(-1, 0)]);
  h.step(0, [0], [false, true, true]);
  h.table.begin(new Set([life]));
  for (const i of [0, 1, 2])
    h.table.request({
      m: h.cars[i]!,
      life,
      tileKey: String(i),
      index: i,
      movement: [movement(1, 0, 0, -1), movement(-1, 0), movement(-1, 0)][i]!,
      ready: i !== 0,
      inside: false,
      atLine: i !== 2,
    });
  h.table.resolve(2);
  expect(h.winners()).toEqual([1, 2]);
});
it('lets a maxWait left turn proceed and orders over-limit traffic oldest first', () => {
  const h = harness([movement(1, 0, 0, -1), movement(-1, 0)]);
  h.step(0, [0], [false, false]);
  h.step(2, [0, 1], [false, false]);
  h.step(11);
  expect(h.winners()).toEqual([0]);
  const ages = harness([movement(0, -1), movement(-1, 0)]);
  ages.step(0, [0], [false, false]);
  ages.step(0.5, [0, 1], [false, false]);
  ages.step(11);
  expect(ages.winners()).toEqual([0]);
});
