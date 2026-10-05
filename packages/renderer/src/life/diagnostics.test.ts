import { expect, it } from 'vitest';
import { FrameProfiler, PROFILE_CAPACITY } from '../profile';
import { makeScenario, completeScenarioState } from './testing/scenarios';
import { displacement, LifeDiagnostics, PackingOutcome } from './diagnostics';
import type { VisibleAgent } from './simulate';
import { LifeWorld } from './simulate';
import { classifyTerminalStops } from '../../scripts/observe-life';
import { LifeBuilder, LifeLine } from './geometry';
import { continuityMover, left } from './testing/continuity';
import { worldTiles } from './testing/scenarios';
import { FOLLOW } from './config';

const bounds = [-1, -1, 1, 1];
const view = (lng = 0): VisibleAgent => ({ kind: 'vehicle', vehicle: 'car', lng, lat: 0, flap: 0 });
function frame(
  sink: LifeDiagnostics,
  owner: object,
  lng = 0,
  hold = false,
  outcome: number = PackingOutcome.drawn,
  admitted = true,
) {
  sink.beginFrame(1, bounds, 17, 1, true);
  sink.eligible(owner, 'vehicle');
  sink.position(owner, lng, 0);
  if (hold) sink.hold(owner, 'signal');
  sink.beginVisible();
  const agent = view(lng);
  sink.view(owner, agent);
  const agents = admitted ? [agent] : [];
  sink.admitted(agents);
  sink.finishFrame(agents, Uint8Array.from(admitted ? [outcome] : []));
}

it('requires ten continuous eligible seconds and resets at intentional holds', () => {
  const sink = new LifeDiagnostics(),
    owner = {};
  for (let i = 0; i < 10; i++) frame(sink, owner);
  expect(sink.report().motion.vehicle.stuckFrames).toBe(0);
  frame(sink, owner);
  expect(sink.report().motion.vehicle).toMatchObject({
    stuckFrames: 1,
    episodes: 1,
    maxSeconds: 10,
  });
  frame(sink, owner, 0, true);
  for (let i = 0; i < 10; i++) frame(sink, owner);
  expect(sink.report().motion.vehicle.stuckFrames).toBe(1);
  expect(sink.report().holds.signal).toBe(1);
  expect(sink.report().motion.person.ratio).toBeNull();
});

it('retains pre-step rejection tags and counts simultaneous packing denials separately', () => {
  const sink = new LifeDiagnostics(),
    owner = {};
  for (let i = 0; i < 12; i++) {
    sink.beginFrame(1, bounds, 17, 1, true);
    sink.tag(owner, 'rejectedSeam');
    sink.eligible(owner, 'vehicle');
    sink.position(owner, 0, 0);
    sink.beginVisible();
    const agent = view();
    sink.view(owner, agent);
    sink.admitted([agent]);
    sink.finishFrame([agent], Uint8Array.of(PackingOutcome.collision), Uint8Array.of(3));
  }
  expect(sink.report().episodeTags.rejectedSeam).toBe(1);
  expect(sink.report().packing).toMatchObject({
    collisionFrames: 12,
    cellGuardFrames: 0,
    collisionDenials: 12,
    cellGuardDenials: 12,
  });
});

it('uses metres across owner transfers and prunes retired histories', () => {
  const sink = new LifeDiagnostics(),
    owner = {};
  expect(displacement({ lng: 0, lat: 0 }, { lng: 0.00001, lat: 0 })).toBeGreaterThan(1);
  for (let i = 0; i < 25; i++) frame(sink, owner, i * 0.00001);
  expect(sink.report().motion.vehicle.stuckFrames).toBe(0);
  for (let i = 0; i < 500; i++) frame(sink, {});
  expect(sink.report().histories).toBe(1);
  expect(sink.views.size).toBe(1);
});

it('counts disappearance transitions separately from rejected frames, caps and view exits', () => {
  const sink = new LifeDiagnostics(),
    owner = {};
  frame(sink, owner);
  frame(sink, owner, 0, false, PackingOutcome.collision);
  frame(sink, owner, 0, false, PackingOutcome.collision);
  frame(sink, owner);
  frame(sink, owner, 0, false, PackingOutcome.cellGuard);
  frame(sink, owner);
  frame(sink, owner, 0, false, PackingOutcome.drawn, false);
  frame(sink, owner);
  frame(sink, owner, 2, false, PackingOutcome.collision);
  expect(sink.report().packing).toMatchObject({
    drawnFrames: 4,
    collisionFrames: 2,
    collisionDisappearances: 1,
    cellGuardFrames: 1,
    cellGuardDisappearances: 1,
    capFrames: 1,
    capDisappearances: 1,
    disappearancesPer1000: 500,
  });
});

it('propagates intentional queue holds and counts recovery only in the physical viewport', () => {
  const sink = new LifeDiagnostics(),
    leader = {},
    follower = {},
    outside = {};
  for (let i = 0; i < 20; i++) {
    sink.beginFrame(1, bounds, 17, 1, true);
    sink.beginVisible();
    const agents = [view(), view(0.1), view(2)];
    for (const [index, owner] of [leader, follower, outside].entries()) {
      sink.eligible(owner, 'vehicle');
      sink.position(owner, agents[index]!.lng, 0);
      sink.view(owner, agents[index]!);
    }
    sink.hold(leader, 'signal');
    sink.following(follower, leader);
    sink.recovery(outside, 'blocked');
    if (i === 0) sink.recovery(follower, 'blocked');
    sink.admitted(agents);
    sink.finishFrame(agents, Uint8Array.from([1, 1, 1]));
  }
  expect(sink.report().motion.vehicle.eligibleFrames).toBe(0);
  expect(sink.report().recoveries.counts).toEqual({ blocked: 1 });
});

it('keeps walker recoveries out of the road-vehicle U-turn rate', () => {
  const sink = new LifeDiagnostics(),
    vehicle = {},
    walker = {};
  sink.beginFrame(30, bounds, 17, 1, true);
  sink.eligible(vehicle, 'vehicle');
  sink.eligible(walker, 'person');
  sink.position(vehicle, 0, 0);
  sink.position(walker, 0, 0);
  sink.recovery(vehicle, 'vehicle');
  sink.recovery(walker, 'walker');
  sink.finishFrame([], new Uint8Array());
  expect(sink.report().recoveries).toEqual({ counts: { vehicle: 1, walker: 1 }, perMinute: 2 });
});

it.each([false, true])(
  'publishes raw terminal stalls and classifies only stopped followers (moving %s)',
  (moving) => {
    const sink = new LifeDiagnostics({ rawMotion: true }),
      root = { v: 0 },
      follower = { v: moving ? 0.1 : 0 };
    for (let i = 0; i < 15; i++) {
      sink.beginFrame(1, bounds, 17, 1, true);
      sink.beginVisible();
      const agents = [view(), view(0.1)];
      for (const [j, owner] of [root, follower].entries()) {
        sink.eligible(owner, 'vehicle');
        sink.position(owner, agents[j]!.lng, 0);
        sink.view(owner, agents[j]!);
      }
      sink.following(follower, root);
      sink.classifyTerminal(root);
      sink.admitted(agents);
      sink.finishFrame(agents, Uint8Array.of(1, 1));
    }
    const r = sink.report();
    expect(r.rawMotion?.vehicle).toMatchObject({ eligibleFrames: 30, stuckFrames: 10 });
    expect(r.motion.vehicle).toMatchObject({
      eligibleFrames: moving ? 15 : 0,
      stuckFrames: moving ? 5 : 0,
    });
    expect(r.terminalHolds).toEqual({
      population: moving ? 1 : 2,
      frames: moving ? 15 : 30,
      maxSeconds: 14,
    });
  },
);

it.each(['terminal', 'clipped', 'building'] as const)(
  'classifies only a physically legal interior one-way endpoint (%s)',
  (mode) => {
    const b = new LifeBuilder(),
      end = mode === 'clipped' ? 4096 : 2000;
    b.line(
      [
        { x: 1000, y: 2000 },
        { x: end, y: 2000 },
      ],
      LifeLine.roadMajor,
      6,
      77,
      1,
    );
    if (mode === 'building')
      b.area('blocked', [
        [
          { x: 1800, y: 1900 },
          { x: 2200, y: 1900 },
          { x: 2200, y: 2200 },
          { x: 1800, y: 2200 },
          { x: 1800, y: 1900 },
        ],
      ]);
    const world = new LifeWorld();
    world.sync([{ key: 'terminal', tile: left, life: b.finish() }]);
    const life = worldTiles(world).get('terminal')!;
    life.movers.length = life.parked.length = life.gatherers.length = life.stalls.length = 0;
    const m = continuityMover(life, end - (2.2 + FOLLOW.minGap) * life.perMeter);
    m.d = m.x - 1000;
    m.v = 0;
    life.movers.push(m);
    const before = structuredClone(m),
      sink = new LifeDiagnostics({ rawMotion: true }),
      agent = view();
    sink.beginFrame(1, bounds, 17, 1, true);
    sink.eligible(m, 'vehicle');
    sink.position(m, 0, 0);
    sink.beginVisible();
    sink.view(m, agent);
    sink.admitted([agent]);
    classifyTerminalStops(world, sink);
    sink.finishFrame([agent], Uint8Array.of(1));
    expect(sink.report().holds.terminal ?? 0).toBe(mode === 'terminal' ? 1 : 0);
    expect(m).toEqual(before);
  },
);

it('keeps weak origin/incarnation/ordinal identities and a bounded chosen-traveler trace', () => {
  const p = new FrameProfiler(() => 0);
  const a = {},
    b = {},
    c = {};
  p.registerPopulation('tile', [a, b]);
  p.registerPopulation('tile', [c]);
  expect(p.identity(a)).toBe('tile#1:0');
  expect(p.identity(b)).toBe('tile#1:1');
  expect(p.identity(c)).toBe('tile#2:0');
  p.observeVisible(a, true);
  for (let i = 0; i < PROFILE_CAPACITY + 5; i++) {
    p.begin(i);
    p.countContinuity('attempts');
    p.traceTraveler(a, { at: i, tile: 'new-owner', event: 'step', lng: i, lat: 0 });
    p.traceTraveler(b, { at: i, tile: 'tile', event: 'step', lng: 0, lat: 0 });
    p.end();
  }
  const report = p.snapshot();
  expect(report.continuity.trace).toHaveLength(PROFILE_CAPACITY);
  expect(report.continuity.trace.every((t) => t.id === 'tile#1:0')).toBe(true);
  report.continuity.trace[0]!.lng = -1;
  expect(p.snapshot().continuity.trace[0]!.lng).toBe(5);
  p.countContinuity('transfers');
  p.reset();
  p.begin(0);
  p.end();
  expect(p.snapshot().continuity).toEqual({ counts: {}, trace: [] });
});

it('profiling preserves complete simulation state and worker delta counts are merged once', () => {
  const sink = new LifeDiagnostics({ rawMotion: true });
  const p = new FrameProfiler(() => 0, sink);
  const plain = makeScenario('junction', 1);
  const profiled = makeScenario('junction', 1, false, 1, undefined, p);
  for (let frame = 0; frame < 60; frame++) {
    p.begin(frame);
    sink.beginFrame(1 / 30, profiled.bounds, 18, 1, true);
    expect(profiled.step(frame)).toEqual(plain.step(frame));
    p.end();
  }
  expect(completeScenarioState(profiled.world)).toEqual(completeScenarioState(plain.world));
  expect(p.snapshot().continuity.trace.length).toBeGreaterThan(0);
  const worker = new FrameProfiler(() => 0),
    main = new FrameProfiler(() => 0);
  worker.countContinuity('transfers', 3);
  worker.begin(1);
  const delta = worker.drain()!;
  expect(worker.drain()).toBeUndefined();
  main.merge(delta);
  main.begin(2);
  main.end();
  expect(main.snapshot().continuity.counts.transfers).toBe(3);
  profiled.world.clearTiles();
  expect(p.snapshot().continuity).toEqual({ counts: {}, trace: [] });
});

it('honors explicit selection, restores automatic selection and clears it on reset', () => {
  const profile = new FrameProfiler(() => 0),
    a = {},
    b = {};
  profile.registerPopulation('tile', [a, b]);
  profile.selectTraveler(profile.identity(b));
  profile.observeVisible(a, true);
  expect(profile.tracing(a)).toBe(false);
  expect(profile.tracing(b)).toBe(true);
  profile.selectTraveler();
  profile.observeVisible(a, true);
  expect(profile.tracing(a)).toBe(true);
  profile.reset();
  expect(profile.tracing(a)).toBe(false);
  profile.observeVisible(b, true);
  expect(profile.tracing(b)).toBe(true);
});
