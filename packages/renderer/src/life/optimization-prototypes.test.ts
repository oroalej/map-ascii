import { expect, it } from 'vitest';
import { FollowingGroups, bucketFollow } from '../../scripts/prototypes/following';
import { VisibleCandidates } from '../../scripts/prototypes/visible-candidates';
import { FOLLOW, MAX_VISIBLE_AGENTS } from './config';
import type { Mover, TileLife, VisibleAgent } from './simulate';
import { random } from './random';
import { VEHICLES, type CraftType } from './vehicles';

it('keeps traversal order below the cap and stable distance order above it', () => {
  const buffer = new VisibleCandidates(),
    life = {} as TileLife;
  const agents: VisibleAgent[] = Array.from({ length: MAX_VISIBLE_AGENTS * 3 }, (_, i) => ({
    kind: 'person',
    lng: (i % 19) - 9,
    lat: (i % 11) - 5,
    flap: i,
  }));
  const staged: VisibleAgent[] = [{ kind: 'boat', lng: 100, lat: 100, flap: 0 }];
  for (const count of [4, MAX_VISIBLE_AGENTS, agents.length, 2]) {
    for (const a of agents.slice(0, count)) buffer.add('ready', life, a, 0, 0, [a.lng, a.lat]);
    const expected = agents.slice(0, count);
    if (count > MAX_VISIBLE_AGENTS)
      expected.sort((a, b) => a.lng ** 2 + a.lat ** 2 - b.lng ** 2 - b.lat ** 2);
    expect(buffer.finish(staged, [0, 0], 0)).toEqual([
      ...staged,
      ...expected.slice(0, MAX_VISIBLE_AGENTS),
    ]);
    expect(buffer).toMatchObject({ count: 0, heap: [] });
    expect(buffer).toHaveProperty('pool.0.life', null);
    expect(buffer).toHaveProperty('pool.0.source', null);
  }
});

it('reuses group arrays and empties groups that have become inactive', () => {
  const scratch = new FollowingGroups(),
    first = scratch.reset(),
    group = [1, 2];
  first.set(42, group);
  expect(scratch.reset()).toBe(first);
  expect(first.get(42)).toBe(group);
  expect(group).toEqual([]);
});

it('matches the original nearest leader for mixed widths, negative offsets, ties, and strict boundaries', () => {
  const rng = random(901),
    kinds = Object.keys(VEHICLES) as CraftType[];
  const n = 300,
    group = Array.from({ length: n }, (_, i) => i);
  const movers = group.map((i): Mover => ({
    kind: 'vehicle',
    line: 0,
    from: 0,
    dir: 1,
    d: 0,
    speed: 10,
    vehicle: kinds[i % kinds.length],
    paint: 0,
    lane: 0,
    pause: 0,
    rank: 0,
    x: 0,
    y: 0,
    hx: 1,
    hy: 0,
  }));
  for (let trial = 0; trial < 25; trial++) {
    const progress = Float64Array.from(group, (i) => Math.floor(i / 2));
    const offsets = Float64Array.from(group, (i) =>
      trial % 2 ? (rng() - 0.5) * 50 : (i % 6) * 0.6 - 2,
    );
    const expected = new Float64Array(n).fill(10),
      actual = expected.slice();
    for (let k = 0; k < n - 1; k++) {
      const i = group[k]!,
        me = VEHICLES[movers[i]!.vehicle!];
      for (let l = k + 1; l < n; l++) {
        const j = group[l]!,
          them = VEHICLES[movers[j]!.vehicle!];
        if (Math.abs(offsets[i]! - offsets[j]!) >= (me.width + them.width) / 2 - FOLLOW.squeeze)
          continue;
        const gap = progress[j]! - progress[i]! - (me.length + them.length) / 2;
        expected[i] = Math.min(10, Math.max(0, (gap - FOLLOW.minGap) / FOLLOW.headway) * 2);
        break;
      }
    }
    bucketFollow(group, progress, offsets, movers, actual, 2);
    expect(actual).toEqual(expected);
  }
  // Exactly at the permitted separation is passable, rather than a blocking leader.
  movers[0]!.vehicle = 'car';
  movers[1]!.vehicle = 'car';
  const offset = new Float64Array([0, VEHICLES.car.width - FOLLOW.squeeze]);
  const speed = new Float64Array([10, 10]);
  bucketFollow([0, 1], new Float64Array([0, 0]), offset, movers, speed, 1);
  expect(speed[0]).toBe(10);
});
