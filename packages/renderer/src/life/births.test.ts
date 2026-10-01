import { expect, it } from 'vitest';
import { LifeWorld } from './simulate';
import { continuityTile, continuityMover, left, parent } from './testing/continuity';
import { completeScenarioState, worldTiles, retiredTiles } from './testing/scenarios';
import { tileToLngLat } from '../raster/geometry';
import { BIRTHS, outsideView, type LifeViewContext } from './births';
import { LifeBuilder, LifeLine } from './geometry';
import { FrameProfiler } from '../profile';
import { activityLevels } from './config';

function context(x0 = 1500, x1 = 2500): LifeViewContext {
  const nw = tileToLngLat(left, { x: x0, y: 1500 }),
    se = tileToLngLat(left, { x: x1, y: 2500 });
  return { bounds: [nw[0], se[1], se[0], nw[1]], spawnMarginM: 12 };
}
function prepared(view = context(), profiler?: FrameProfiler, internalEndpoints = false) {
  const world = new LifeWorld({ road_major: { car: 1 } }, profiler);
  const boot = continuityTile({ ...left, x: left.x - 1 });
  world.sync([boot], undefined, view);
  const bootstrap = worldTiles(world).get(boot.key)!;
  expect(bootstrap.pending).toHaveLength(0);
  bootstrap.movers.splice(0);
  const entry = continuityTile(left);
  if (internalEndpoints) {
    const b = new LifeBuilder();
    b.line(
      [
        { x: 800, y: 2000 },
        { x: 3200, y: 2000 },
      ],
      LifeLine.roadMajor,
      6,
      77,
    );
    entry.life = b.finish();
  }
  world.sync([boot, entry], undefined, view);
  return { world, boot, entry, life: worldTiles(world).get(entry.key)!, view };
}

it('keeps eager compatibility and bootstrap, then admits inert seeds entirely outside the view', () => {
  const eager = new LifeWorld();
  eager.sync([continuityTile(left)]);
  expect([...worldTiles(eager).values()][0]!.pending).toHaveLength(0);
  expect([...worldTiles(eager).values()][0]!.movers.length).toBeGreaterThan(0);
  const { world, life, view } = prepared();
  expect(life.movers).toHaveLength(0);
  expect(life.pending.length).toBeGreaterThan(0);
  const seeds = life.pending.map((p) => p.mover);
  const initial = new Map(seeds.map((m) => [m, structuredClone(m)]));
  world.step(0.1, undefined, 18, view.bounds);
  expect(life.movers.length).toBeGreaterThan(0);
  for (const m of life.movers) {
    expect(outsideView(life, life.birthBodies(m), view, 12)).toBe(true);
    expect(m).toEqual(initial.get(m)); // Birth happens after the step; no hidden time advance.
  }
  for (const p of life.pending) expect(p.mover).toEqual(initial.get(p.mover));
});

it('attempts at most 32 seeds fairly and never refills canceled slots', () => {
  const p = new FrameProfiler(() => 0),
    { world, life, view, boot, entry } = prepared(context(0, 4096), p);
  const seeds = Array.from({ length: 80 }, (_, i) => ({
    mover: continuityMover(life, 2000 + i * 0.01),
    at: life.elapsed,
  }));
  life.pending.splice(0, life.pending.length, ...seeds);
  p.begin(1);
  world.step(0.1, undefined, 18, view.bounds);
  p.end();
  // Population construction also counts births, but the frame's admission attempts are bounded.
  expect(p.snapshot().samples.at(-1)!.continuity!.counts.attempts).toBeLessThanOrEqual(
    BIRTHS.attempts,
  );
  expect(life.pending[0]).toBe(seeds[32]);
  life.pending.splice(0);
  world.sync([boot, entry], undefined, view);
  world.step(0.1, undefined, 18, view.bounds);
  expect(life.pending).toHaveLength(0);
});

it('uses bounded simulated-time entry credits after one second and hard clears them', () => {
  const { world, life, view } = prepared(context(0, 4096), undefined, true);
  // Genuine internal route endpoints; clipped outer endpoints cannot force an unsafe birth.
  life.pending.splice(
    0,
    life.pending.length,
    ...Array.from({ length: 30 }, () => ({
      mover: { ...continuityMover(life, 2000), from: 0, d: 1200 },
      at: life.elapsed,
    })),
  );
  const initial = life.pending.length;
  for (let frame = 0; frame < 9; frame++) world.step(0.1, undefined, 18, view.bounds);
  expect(life.movers).toHaveLength(0);
  world.step(1e6, undefined, 18, view.bounds); // Accepted dt is clamped, with no background catchup.
  expect(life.elapsed).toBeLessThanOrEqual(1.00001);
  for (let frame = 0; frame < 60; frame++) world.step(0.1, undefined, 18, view.bounds);
  expect(life.movers.length).toBeGreaterThan(0);
  expect(initial - life.pending.length).toBeLessThanOrEqual(4 * 7);
  expect(life.birthCredit).toBeLessThanOrEqual(4);
  world.clearTiles();
  expect(completeScenarioState(world).birthCredit).toBe(0);
  expect(completeScenarioState(world).pending).toEqual([]);
});

it('lets zoom carries consume pending slots and protects previously visible residents', () => {
  const world = new LifeWorld({ road_major: { car: 1 } }),
    view = context(),
    p = continuityTile(parent);
  world.sync([p], undefined, view);
  const source = worldTiles(world).get(p.key)!,
    m = continuityMover(source, 600);
  source.movers.splice(0, source.movers.length, m);
  world.visible(18, activityLevels(1), [123, 13]);
  const child = continuityTile(left);
  world.sync([child], undefined, view);
  const target = worldTiles(world).get(child.key)!;
  expect(target.movers).toContain(m);
  const count = target.pending.length;
  world.sync([child], undefined, view);
  expect(target.pending).toHaveLength(count);
  // Returning an owned, visible resident must preserve its object, not replace it with a donor.
  world.visible(18, activityLevels(1), [123, 13]);
  world.sync([p, child], undefined, view);
  expect(target.movers).toContain(m);
});

it('freezes pending age/credits on retirement, revives identity, and expiry creates a new pool', () => {
  const { world, life, view, boot, entry } = prepared(context(0, 4096));
  world.step(0.1, undefined, 18, view.bounds);
  world.sync([boot], undefined, view);
  const before = completeScenarioState(world).retired;
  for (let i = 0; i < 30; i++) world.step(0.1, undefined, 18, view.bounds);
  expect(completeScenarioState(world).retired).toEqual(before);
  world.sync([boot, entry], undefined, view);
  expect(worldTiles(world).get(entry.key)).toBe(life);
  world.sync([boot], undefined, view);
  for (let i = 0; i < 81; i++) world.step(0.1, undefined, 18, view.bounds);
  expect(retiredTiles(world).has(entry.key)).toBe(false);
  world.sync([boot, entry], undefined, view);
  expect(worldTiles(world).get(entry.key)).not.toBe(life);
});

it('evaluates the full group and consist for offscreen admission', () => {
  const { life, view } = prepared(context(1500, 2500));
  const m = continuityMover(life, 1500 - 13 * life.perMeter, 'person');
  m.group = [{ figure: 'adult', shirt: 1, umbrella: 0, canopy: 2, lateral: 0, back: -5, step: 0 }];
  expect(outsideView(life, life.birthBodies(m), view, 12)).toBe(false);
  const train = continuityMover(life, 1500 - 13 * life.perMeter, 'train');
  train.train!.trail = [
    train.x + 10 * life.perMeter,
    train.y,
    train.x + 40 * life.perMeter,
    train.y,
  ];
  expect(outsideView(life, life.birthBodies(train), view, 12)).toBe(false);
});
