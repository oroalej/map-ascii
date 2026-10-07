import { expect, it } from 'vitest';
import { cruise } from './driving';
import { projectMover, SegmentGrid } from './continuity';
import { TileLife } from './simulate';
import { continuityMover, continuityTile, left, parent, right } from './testing/continuity';

it.each([right, parent])(
  'carries the burst and pace to tile $z/$x/$y when the slot is free',
  (tile) => {
    const a = continuityTile(left),
      b = continuityTile(tile);
    const source = new TileLife(left, a.life, 1),
      target = new TileLife(tile, b.life, 2);
    source.movers.length = target.movers.length = 0;
    const m = continuityMover(source, tile === right ? 4095 : 2000);
    m.rush = 5;
    source.movers.push(m);
    const preview = projectMover(target, source, m, new SegmentGrid(target.geo, target.perMeter));
    expect(preview?.rush).toBe(5);
    expect(cruise(preview!, false) / target.perMeter).toBeCloseTo(
      cruise(m, false) / source.perMeter,
    );
    const v = m.v! / source.perMeter;
    expect(target.adoptFrom(m, source)).toBe(true);
    expect(m.rush).toBe(5);
    expect(m.v! / target.perMeter).toBeCloseTo(v);
  },
);

it('leaves a failed admission untouched and ends only the incoming burst on a quota conflict', () => {
  const a = continuityTile(left),
    b = continuityTile(right);
  const source = new TileLife(left, a.life, 1),
    target = new TileLife(right, b.life, 2);
  source.movers.length = target.movers.length = 0;
  const incoming = continuityMover(source, 4095),
    resident = continuityMover(target, 1000);
  incoming.rush = resident.rush = 5;
  source.movers.push(incoming);
  target.movers.push(resident);
  const saved = structuredClone(incoming);
  expect(target.adoptFrom(incoming, source, {}, () => false)).toBe(false);
  expect(incoming).toEqual(saved);
  expect(resident.rush).toBe(5);
  expect(target.adoptFrom(incoming, source)).toBe(true);
  expect(incoming.rush).toBe(0);
  expect(resident.rush).toBe(5);
  expect(incoming.v).toBe(saved.v);
});

it('excludes a replaced resident from the destination quota', () => {
  const geo = continuityTile(left).life;
  const source = new TileLife(left, geo, 1),
    target = new TileLife(left, geo, 2);
  source.movers.length = target.movers.length = 0;
  const m = continuityMover(source, 2000),
    replacement = continuityMover(target, 2000);
  m.rush = replacement.rush = 5;
  source.movers.push(m);
  target.movers.push(replacement);
  expect(target.adoptFrom(m, source, { replace: replacement })).toBe(true);
  expect(target.movers).toEqual([m]);
  expect(m.rush).toBe(5);
});
