import { expect, it, vi } from 'vitest';
import { LifeWorld, TileLife, type Mover, type WorldGroundGuard } from './simulate';
import { continuityTile, continuityMover, left, parent } from './testing/continuity';
import { completeScenarioState, worldTiles, retiredTiles } from './testing/scenarios';
import { tileToLngLat } from '../raster/geometry';
import { BIRTHS, admitBirths, outsideView, spawnMargin, type LifeViewContext } from './births';
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

function endpointAdmission(
  kind: 'split' | 'different-way' | 'disconnected' | 'offscreen' | 'person',
) {
  const b = new LifeBuilder();
  const junction = kind === 'offscreen' ? 1000 : 2000;
  b.line(
    [
      { x: 800, y: 2000 },
      { x: junction, y: 2000 },
    ],
    LifeLine.roadMajor,
    6,
    77,
  );
  b.line(
    [
      { x: junction, y: 2000 },
      { x: 3200, y: 2000 },
    ],
    LifeLine.roadMajor,
    6,
    77,
  );
  let line = 1;
  if (kind === 'different-way' || kind === 'person') {
    b.line(
      [
        { x: junction, y: 2000 },
        { x: junction, y: 3200 },
      ],
      kind === 'person' ? LifeLine.path : LifeLine.roadMinor,
      6,
      88,
    );
    line = 2;
  }
  if (kind === 'disconnected') {
    b.line(
      [
        { x: 1200, y: 2200 },
        { x: 3000, y: 2200 },
      ],
      LifeLine.roadMinor,
      6,
      99,
    );
    line = 2;
  }
  const life = new TileLife(left, b.finish(), 4);
  life.movers.length = 0;
  const traveler: Mover = {
    ...continuityMover(life, junction, kind === 'person' ? 'person' : 'vehicle'),
    line,
    from: life.geo.starts[line]!,
    dir: 1,
    d: 0,
    speed: 0,
    v: 0,
  };
  if (kind === 'person')
    traveler.group = [
      { figure: 'adult', shirt: 0, umbrella: 0, canopy: 0, lateral: 0, back: 0, step: 0 },
    ];
  const m = life.placeSeed(traveler, kind === 'offscreen' ? 1100 : 100)!;
  const view = kind === 'offscreen' ? context(1500, 2500) : context(0, 4096);
  expect(life.birthBodies(m).length).toBeGreaterThan(0);
  expect(outsideView(life, life.birthBodies(m), view, 12)).toBe(false);
  for (let frame = 0; frame < 11; frame++) life.step(0.1);
  life.birthCredit = 1;
  life.pending.push({ mover: m, at: 0 });
  // Isolate entrance policy from terrain/collision admission, covered by the world tests below.
  const walkable =
    kind === 'person' ? vi.spyOn(life.scenes, 'walkable').mockReturnValue(true) : undefined;
  admitBirths(
    {
      view,
      lives: [life],
      credit: 4,
      cursor: 0,
      owns: () => true,
      guard: () => Object.assign(() => true, { remove: () => {}, reserveSeam: () => {} }),
      boatRoom: () => true,
    },
    0.1,
  );
  walkable?.mockRestore();
  return { life, m, view };
}

it('rejects in-view endpoint births at a same-way split and a different-way T-junction', () => {
  for (const kind of ['split', 'different-way'] as const) {
    const { life, m } = endpointAdmission(kind);
    expect(life.continuesRoad(m.line, true)).toBe(true);
    expect(life.movers).not.toContain(m);
    expect(life.pending[0]!.mover).toBe(m);
  }
});

it('retains the in-view exemption at a disconnected road end', () => {
  const { life, m, view } = endpointAdmission('disconnected');
  expect(life.continuesRoad(m.line, true)).toBe(false);
  expect(life.movers).toContain(m);
  expect(outsideView(life, life.birthBodies(m), view, 0)).toBe(false);
});

it('admits a connected endpoint offscreen and preserves non-vehicle endpoint admission', () => {
  const outside = endpointAdmission('offscreen');
  expect(outside.life.continuesRoad(outside.m.line, true)).toBe(true);
  expect(outside.life.movers).toContain(outside.m);
  expect(outsideView(outside.life, outside.life.birthBodies(outside.m), outside.view, 0)).toBe(
    true,
  );
  const person = endpointAdmission('person');
  expect(person.life.continuesRoad(person.m.line, true)).toBe(true);
  expect(person.life.movers).toContain(person.m);
  expect(outsideView(person.life, person.life.birthBodies(person.m), person.view, 0)).toBe(false);
});

it('recognizes the other end of a closed road while ignoring connected paths', () => {
  const b = new LifeBuilder();
  b.line(
    [
      { x: 1000, y: 2000 },
      { x: 2000, y: 2000 },
      { x: 1000, y: 2000 },
    ],
    LifeLine.roadMinor,
  );
  b.line(
    [
      { x: 2000, y: 2200 },
      { x: 3000, y: 2200 },
    ],
    LifeLine.roadMinor,
  );
  b.line(
    [
      { x: 3000, y: 2200 },
      { x: 3000, y: 3200 },
    ],
    LifeLine.path,
  );
  const life = new TileLife(left, b.finish(), 4);
  expect(life.continuesRoad(0, true)).toBe(true);
  expect(life.continuesRoad(0, false)).toBe(true);
  expect(life.continuesRoad(1, false)).toBe(false);
});

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

it('expires permanently blocked seeds without rebuilding the world guard every step', () => {
  const builder = new LifeBuilder();
  builder.line(
    [
      { x: -100, y: 2000 },
      { x: 4196, y: 2000 },
    ],
    LifeLine.roadMajor,
    6,
    77,
  );
  builder.area('blocked', [
    [
      { x: 0, y: 0 },
      { x: 4096, y: 0 },
      { x: 4096, y: 4096 },
      { x: 0, y: 4096 },
      { x: 0, y: 0 },
    ],
  ]);
  const world = new LifeWorld(),
    view = context(),
    entry = { key: 'blocked', tile: left, life: builder.finish() };
  world.sync([entry], undefined, view);
  const life = worldTiles(world).get(entry.key)!;
  life.movers.splice(0);
  life.pending.push({ mover: continuityMover(life, 500), at: life.elapsed });
  const guard = vi.spyOn(
    world as unknown as { groundGuard(...args: unknown[]): WorldGroundGuard },
    'groundGuard',
  );
  for (let frame = 0; frame < 600; frame++) world.step(0.1, undefined, 18, view.bounds);
  expect(life.pending).toHaveLength(0);
  expect(life.movers).toHaveLength(0);
  const birthBuilds = guard.mock.calls.filter((args) => args[3] === true);
  expect(birthBuilds.length).toBeGreaterThan(0);
  expect(birthBuilds.length).toBeLessThanOrEqual(BIRTHS.maxFailures);
  expect(birthBuilds.every((args) => args[4] instanceof Set)).toBe(true);
  guard.mockClear();
  for (let frame = 0; frame < 20; frame++) world.step(0.1, undefined, 18, view.bounds);
  expect(guard.mock.calls.some((args) => args[3] === true)).toBe(false);
  guard.mockRestore();
});

it('derives the same CSS margin for tall and wide cells without imposing the minimum twice', () => {
  expect(spawnMargin(5, 1.8)).toBe(18);
  expect(spawnMargin(5, 0.5)).toBe(10);
  expect(spawnMargin(1, 1.8)).toBe(3.6);
});

it('keeps near hidden residents in birth clearance while excluding distant tiles', () => {
  const { world, life, view, boot, entry } = prepared();
  const far = continuityTile({ ...left, x: left.x + 10 });
  world.sync([boot, entry, far], undefined, view);
  const distant = worldTiles(world).get(far.key)!;
  distant.pending.splice(0);
  const seed = continuityMover(life, 500),
    blocker = { ...seed, rank: 1, speed: 0, v: 0 };
  life.pending.splice(0, life.pending.length, { mover: seed, at: life.elapsed });
  life.movers.splice(0, life.movers.length, blocker);
  for (const tile of worldTiles(world).values()) if (tile !== life) tile.pending.splice(0);
  world.visible(18, activityLevels(0), [123, 13]);
  const calls = vi.spyOn(distant, 'groundBodies');
  const internal = world as unknown as { admitBirths(dt: number): void };
  internal.admitBirths(0.1);
  expect(life.movers).not.toContain(seed);
  expect(life.pending).toHaveLength(1);
  expect(calls).not.toHaveBeenCalled();
  calls.mockRestore();
});
