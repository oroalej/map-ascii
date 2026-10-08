import { describe, expect, it, vi } from 'vitest';
import { resolveTap, TapQueue, TapSources, type LifeTap, type TapHandlers } from './tap';
import type { VisibleAgent } from './simulate';
import { makeScenario, completeScenarioState } from './testing/scenarios';
import { LifeWorld } from './simulate';
import { continuityTile, continuityMover, left } from './testing/continuity';
import { LifeLine } from './geometry';
import { folkloreTile, folkloreConfig, folkloreCenter, calendar } from './testing/folklore';
import { lngLatToTile } from '../raster/geometry';
it('a ghost tap requests fear from at most six nearby visible people', () => {
  const world = new LifeWorld(undefined, undefined, { enabled: false });
  world.enableTaps();
  world.setFolklore(folkloreConfig);
  const source = folkloreTile();
  world.sync([{ key: source.key, tile: source.tile, life: source.geo }]);
  for (let i = 0; i < 2; i++)
    world.step(6, undefined, 19, undefined, undefined, {
      minutes: 1320,
      folkloreDate: calendar(),
      rain: 0,
    });
  const ghost = world
    .visibleFolklore(19, folkloreCenter)
    .sprites.find((s) => s.id.includes('/hospital/'))!;
  const life = world.resident(source.key)!;
  const at = lngLatToTile(source.tile, ghost.lng, ghost.lat);
  const people = Array.from({ length: 8 }, (_, i) => {
    const person = continuityMover(life, at.x + i * life.perMeter * 0.5, 'person');
    person.y = at.y;
    person.group = [
      { figure: 'adult', shirt: 0, umbrella: 1, canopy: 0, lateral: 0, back: 0, step: 0 },
    ];
    return person;
  });
  life.movers.splice(0, life.movers.length, ...people);
  world.visible(19, 1, folkloreCenter);
  const request = vi.spyOn(life, 'requestEmoji');
  world.step(
    0,
    undefined,
    19,
    undefined,
    undefined,
    { minutes: 1320, folkloreDate: calendar(), rain: 0 },
    1,
    1.8,
    1,
    undefined,
    [
      {
        id: 1,
        generation: 1,
        frame: world.tapSources!.frame,
        at: [ghost.lng, ghost.lat],
        pointer: 'touch',
        cellMeters: 1,
        folklore: ghost.id,
      },
    ],
  );
  expect(world.tapReceipts![0]!.action).toBe('folklore');
  expect(request).toHaveBeenCalledTimes(6);
  expect(request.mock.calls.every((args) => args[2] === 'scared')).toBe(true);
});

function vehicleWorld(kind: 'vehicle' | 'train' | 'dog' | 'cat' = 'vehicle') {
  const world = new LifeWorld(undefined, undefined, undefined, false);
  world.enableTaps();
  const entry = continuityTile(
    left,
    kind === 'train' ? LifeLine.rail : kind === 'vehicle' ? LifeLine.roadMajor : LifeLine.path,
  );
  world.sync([entry]);
  const life = world.resident(entry.key)!;
  life.stalls.length = 0;
  life.gatherers.length = 0;
  life.flocks.length = 0;
  const vehicle = continuityMover(life, 1800, kind);
  if (vehicle.train) vehicle.train.trail = [1800 - 100 * life.perMeter, vehicle.y];
  const person = continuityMover(life, 1800 + 10 * life.perMeter, 'person');
  person.group = [
    { figure: 'adult', shirt: 0, umbrella: 0.1, canopy: 0, lateral: 0, back: 0, step: 0 },
  ];
  person.speed = life.perMeter;
  person.y += 2 * life.perMeter;
  life.movers.splice(0, life.movers.length, vehicle, person);
  world.setEmojiView([19, 1, [0, 0]]);
  const agents = world.visible(19, 1, [0, 0]);
  const index = agents.findIndex(
    (a) => a.kind === kind && (!vehicle.train || a.vehicle === 'coach'),
  );
  const selected = agents[index]!;
  const tap: LifeTap = {
    id: 11,
    generation: 1,
    frame: world.tapSources!.frame,
    at: [selected.lng, selected.lat],
    pointer: 'touch',
    cellMeters: 1,
    agent: index,
  };
  return { world, life, vehicle, person, tap };
}
it.each(['car', 'jeepney'] as const)(
  'honks a %s and requests a guarded two-second hurry without riders',
  (craft) => {
    const f = vehicleWorld();
    f.vehicle.vehicle = craft;
    f.world.step(0.01, undefined, 19, undefined, undefined, { rain: 0 }, 1, 1.8, 1, undefined, [
      f.tap,
    ]);
    expect(f.world.tapReceipts).toEqual([{ id: 11, action: 'agent' }]);
    expect(f.world.emojiMemory.cue(f.vehicle)?.mood).toBe('honk');
    expect(f.world.emojiMemory.cue(f.person)?.mood).toBe('rushing');
    expect(f.person.pause).toBe(0);
  },
);
it('resolves a coach to its consist, but renders the requested horn only on the locomotive', () => {
  const f = vehicleWorld('train');
  expect(f.world.visible(19, 1, [0, 0]).filter((a) => a.emoji)).toEqual([]);
  f.world.step(0.01, undefined, 19, undefined, undefined, { rain: 0 }, 1, 1.8, 1, undefined, [
    f.tap,
  ]);
  const cues = f.world.visible(19, 1, [0, 0]).filter((a) => a.kind === 'train' && a.emoji);
  expect(cues).toHaveLength(1);
  expect(cues[0]!.vehicle).toBe('locomotive');
  expect(cues[0]!.emoji?.mood).toBe('honk');
});
it.each(['dog', 'cat'] as const)(
  'wakes a sleeping %s through the normal guarded movement path',
  (kind) => {
    const f = vehicleWorld(kind);
    f.vehicle.pause = 20;
    f.vehicle.lying = kind === 'dog';
    f.vehicle.grooming = kind === 'cat';
    const agents = f.world.visible(19, 1, [0, 0]);
    const agent = agents.findIndex((a) => a.kind === kind);
    f.world.step(0.01, undefined, 19, undefined, undefined, { rain: 0 }, 1, 1.8, 1, undefined, [
      { ...f.tap, frame: f.world.tapSources!.frame, agent },
    ]);
    expect(f.vehicle.pause).toBe(0);
    expect(f.vehicle.lying || f.vehicle.grooming).toBe(false);
    expect(f.world.emojiMemory.cue(f.vehicle)?.mood).toBe('yawn');
  },
);
it('answers a bark nearest-first with deterministic delays, six dogs maximum and no restart', () => {
  const f = vehicleWorld();
  f.life.movers.length = 0;
  const dogs = Array.from({ length: 8 }, (_, i) =>
    continuityMover(f.life, 1800 + i * 2 * f.life.perMeter, 'dog'),
  );
  f.life.movers.push(...dogs);
  const agents = f.world.visible(19, 1, [0, 0]);
  const spy = vi.spyOn(f.life, 'requestEmoji');
  const tap = {
    ...f.tap,
    frame: f.world.tapSources!.frame,
    agent: agents.findIndex((a) => a.kind === 'dog'),
  };
  f.world.step(0, undefined, 19, undefined, undefined, { rain: 0 }, 1, 1.8, 1, undefined, [
    tap,
    { ...tap, id: 12 },
  ]);
  expect(spy.mock.calls.map(([owner]) => owner)).toEqual(dogs.slice(0, 6));
  spy.mock.calls.forEach((args, i) => expect(args[5]).toBeCloseTo([0, 0.4, 0.6, 0.8, 1, 1.2][i]!));
});
it.each([false, true])('consumes a closed/rainy cart without a visit or wave (rain=%s)', (rain) => {
  const f = vehicleWorld();
  const stall = {
    x: 1800,
    y: f.vehicle.y,
    hx: 1,
    hy: 0,
    paint: 0,
    shirt: 0,
    side: 1 as const,
    rank: 0,
    open: true,
  };
  f.life.stalls.push(stall);
  f.life.scenes.addStall(stall);
  const agents = f.world.visible(19, 1, [0, 0]);
  const agent = agents.findIndex((a) => a.vehicle === 'cart');
  expect(agent).toBeGreaterThanOrEqual(0);
  stall.open = rain;
  f.world.step(
    0.01,
    undefined,
    19,
    undefined,
    undefined,
    { rain: rain ? 1 : 0 },
    1,
    1.8,
    1,
    undefined,
    [{ ...f.tap, frame: f.world.tapSources!.frame, agent }],
  );
  expect(f.world.tapReceipts![0]!.action).toBe('agent');
  expect(f.life.scenes.visits.size).toBe(0);
  expect(f.world.emojiMemory.cue(stall)?.mood).not.toBe('wave');
});
it('leaves tap-free physical state and visible records identical with frame targeting enabled', () => {
  const a = makeScenario('sparse', 1, true),
    b = makeScenario('sparse', 1, true);
  b.world.enableTaps();
  for (let i = 0; i < 20; i++) {
    a.step(1 / 30);
    b.step(1 / 30);
    expect(b.world.visible(19, 1, b.center)).toEqual(a.world.visible(19, 1, a.center));
  }
  expect(completeScenarioState(b.world)).toEqual(completeScenarioState(a.world));
  expect(b.world.tapReceipts).toBeUndefined();
});

const agent: VisibleAgent = { kind: 'cat', lng: 0, lat: 0, ahead: [1, 0] };
function fixture() {
  const sources = new TapSources();
  sources.begin();
  sources.present({}, agent);
  sources.finish([agent]);
  const tap: LifeTap = {
    id: 1,
    generation: 1,
    frame: sources.frame,
    at: [0, 0],
    pointer: 'touch',
    cellMeters: 1,
  };
  const handlers: TapHandlers = {
    folklore: vi.fn(() => false),
    agent: vi.fn(),
    signal: vi.fn(() => false),
    procession: vi.fn(() => false),
    carnival: vi.fn(),
    candle: vi.fn(),
    tree: vi.fn(() => false),
    rice: vi.fn(() => true),
  };
  return { sources, tap, handlers };
}
describe('tap arbitration', () => {
  it('consumes a matched inactive cat instead of reaching a firework or feed', () => {
    const f = fixture();
    expect(resolveTap({ ...f.tap, agent: 0, firework: true }, f.sources, f.handlers).action).toBe(
      'agent',
    );
    expect(f.handlers.rice).not.toHaveBeenCalled();
    expect(f.handlers.signal).not.toHaveBeenCalled();
  });
  it.each(['folklore', 'signal', 'procession', 'tree'] as const)(
    'stops at the first accepted %s',
    (kind) => {
      const f = fixture();
      f.handlers[kind] = vi.fn(() => true);
      const receipt = resolveTap(
        { ...f.tap, folklore: 'ghost', firework: true },
        f.sources,
        f.handlers,
      );
      expect(receipt.action).toBe(kind);
      expect(f.handlers.rice).not.toHaveBeenCalled();
    },
  );
  it('puts fixture choices ahead of trees and fireworks, and never uses a second worker tap', () => {
    const f = fixture();
    const receipt = resolveTap(
      {
        ...f.tap,
        carnival: { key: 'ride', at: [0, 0] },
        candle: { key: 'candle', at: [0, 0] },
        firework: true,
      },
      f.sources,
      f.handlers,
    );
    expect(receipt.action).toBe('carnival');
    expect(f.handlers.carnival).toHaveBeenCalledOnce();
    expect(f.handlers.candle).not.toHaveBeenCalled();
    expect(f.handlers.tree).not.toHaveBeenCalled();
  });
  it('drops stale frame handles and invalid candidate indices without selecting an owner', () => {
    const f = fixture();
    f.sources.finish([]);
    expect(resolveTap({ ...f.tap, agent: 0 }, f.sources, f.handlers).action).toBe('agent');
    f.sources.finish([]);
    expect(resolveTap(f.tap, f.sources, f.handlers).action).toBeUndefined();
    expect(
      resolveTap({ ...f.tap, frame: f.sources.frame, agent: 5 }, f.sources, f.handlers).action,
    ).toBeUndefined();
    expect(agent.inspectionId).toBeUndefined();
  });
});
describe('tap queue', () => {
  it('retains rejected batches, bounds outstanding work, and consumes cached receipts once', () => {
    const f = fixture(),
      queue = new TapQueue();
    for (let i = 0; i < 5; i++) queue.add(f.tap);
    const batch = queue.batch(1)!;
    expect(batch).toHaveLength(4);
    expect(queue.batch(1)).toEqual(batch);
    queue.accepted(batch);
    expect(queue.batch(1)).toBeUndefined();
    const receipts = batch.map((tap) => ({ id: tap.id, action: 'rice' as const }));
    expect(queue.consume(receipts, 1)).toHaveLength(4);
    expect(queue.consume(receipts, 1)).toEqual([]);
  });
  it('drops pending commands and replies across resets and generation changes', () => {
    const f = fixture(),
      queue = new TapQueue();
    queue.add(f.tap);
    expect(queue.batch(2)).toBeUndefined();
    queue.add(f.tap);
    const batch = queue.batch(1)!;
    queue.accepted(batch);
    queue.clear();
    expect(queue.consume([{ id: batch[0]!.id, action: 'rice' }], 1)).toEqual([]);
  });
});
