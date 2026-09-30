import { describe, expect, it } from 'vitest';
import { JunctionTable, compatible, type Movement } from './junctions';
import { LifeBuilder, LifeLine } from './geometry';
import { TileLife, type Mover } from './simulate';

const life = new TileLife({ z: 16, x: 1, y: 1 }, new LifeBuilder().finish(), 1);
const mover = () => ({ kind: 'vehicle', vehicle: 'car' }) as Mover;
const movement = (ix: number, iy: number, ox: number, oy: number, rank = 0): Movement => ({
  key: 'cross',
  junction: { key: 'cross', x: 0, y: 0, radius: 7, arms: [] },
  inHx: ix,
  inHy: iy,
  outHx: ox,
  outHy: oy,
  rank,
  stop: 0,
  line: 0,
  dir: 1,
  exit: { line: 1, along: 0, out: 1, hx: ox, hy: oy },
  ahead: 2,
});
const east = movement(1, 0, 1, 0),
  south = movement(0, 1, 0, 1, LifeLine.roadMinor);
describe('junction arbitration', () => {
  it('allows same approaches, opposing through traffic and distinct right turns', () => {
    expect(compatible(east, east)).toBe(true);
    expect(compatible(east, movement(-1, 0, -1, 0))).toBe(true);
    expect(compatible(east, south)).toBe(false);
    expect(compatible(east, movement(0, 1, 1, 0))).toBe(false);
    expect(compatible(movement(1, 0, 0, 1), movement(0, 1, -1, 0))).toBe(true);
  });
  it('uses road rank in the arrival tie and ages a conflicting waiter', () => {
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
