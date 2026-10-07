import { expect, it } from 'vitest';
import { JunctionTable, type Movement } from './junctions';
import { LifeBuilder } from './geometry';
import { TileLife, type Mover } from './simulate';

function cycle(reverse: boolean, blocked = false, committed = false) {
  const life = new TileLife({ z: 16, x: 55192, y: 30266 }, new LifeBuilder().finish(), 1);
  const table = new JunctionTable();
  const a = { kind: 'vehicle', vehicle: 'jeepney' } as Mover;
  const b = { kind: 'vehicle', vehicle: 'tricycle' } as Mover;
  const movement = (
    key: string,
    x: number,
    ix: number,
    iy: number,
    ox: number,
    oy: number,
  ): Movement => ({
    key,
    junction: { key, x: x * life.perMeter, y: 0, radius: 4 * life.perMeter, arms: [] },
    inHx: ix,
    inHy: iy,
    outHx: ox,
    outHy: oy,
    stop: 0,
    line: 0,
    dir: 1,
    exit: { line: 1, along: 0, out: 1, hx: ox, hy: oy },
    ahead: 0,
  });
  const ax = movement('x', 0, 1, 0, 1, 0);
  const ay = movement('y', 6, 1, 0, 0, 1);
  const by = movement('y', 6, 0, -1, -1, 0);
  const bx = movement('x', 0, -1, 0, 0, 1);
  ay.ahead = bx.ahead = 6 * life.perMeter;
  const step = (clock: number, downstream: boolean, entered = false) => {
    table.begin(new Set([life]));
    const requests = [
      { m: a, index: 0, movement: ax, inside: entered, atLine: true, ready: true },
      { m: b, index: 1, movement: by, inside: committed, atLine: true, ready: true },
      ...(downstream
        ? [
            { m: a, index: 0, movement: ay, precedingKey: 'x', inside: false, ready: !blocked },
            { m: b, index: 1, movement: bx, precedingKey: 'y', inside: false, ready: true },
          ]
        : []),
    ];
    for (const request of reverse ? requests.reverse() : requests)
      table.request({ ...request, life, tileKey: 'tile', room: Infinity });
    table.resolve(clock);
  };
  step(0, false);
  expect(table.granted(a, 'x')).toBe(true);
  expect(table.granted(b, 'y')).toBe(true);
  step(1, true);
  expect(table.canEnter(a, 'x')).toBe(false);
  return { table, a, b, step };
}

for (const reverse of [false, true]) {
  it(`clears reciprocal outside reservations without entering an unstorable link (reverse=${reverse})`, () => {
    const { table, a, b, step } = cycle(reverse);
    expect(table.canEnter(b, 'y')).toBe(false);
    step(11, true);
    expect(table.canEnter(a, 'x')).toBe(true);
    expect(table.canEnter(a, 'y')).toBe(true);
    expect(table.granted(b, 'y')).toBe(false);
    expect(table.granted(b, 'x')).toBe(false);
    expect(table.waited(b, 'y')).toBe(11);
    step(12, true, true);
    expect(table.canEnter(a, 'x')).toBe(true);
    expect(table.canEnter(a, 'y')).toBe(true);
    expect(table.canEnter(b, 'y')).toBe(false);
  });

  it(`retains downstream closure and committed-box protection (reverse=${reverse})`, () => {
    const closed = cycle(reverse, true);
    closed.step(11, true);
    expect(closed.table.canEnter(closed.a, 'x')).toBe(false);
    expect(closed.table.granted(closed.b, 'y')).toBe(true);

    const occupied = cycle(reverse, false, true);
    occupied.step(11, true);
    expect(occupied.table.canEnter(occupied.a, 'x')).toBe(false);
    expect(occupied.table.granted(occupied.b, 'y')).toBe(true);
  });
}
