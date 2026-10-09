import { expect, it, vi } from 'vitest';
import type { DialogueChoice, FluvialRoute, StreetRoute } from '@atlas/shared';
import { LifeWorld } from './simulate';
import { EventTaps } from './event-taps';
import { ProcessionScene } from './procession';
import type { LifeTap } from './tap';
import { LifeBuilder, LifeLine } from './geometry';
import { left } from './testing/continuity';
import { tileToLngLat, metersPerUnit } from '../raster/geometry';
import * as EventCues from './event-cues';

const route: FluvialRoute = {
  id: 'procession/test',
  title: { en: 'Test' },
  status: 'draft',
  kind: 'fluvial',
  route: [
    [0, 0],
    [0.009, 0],
  ],
  length_m: 1000,
  schedule: {
    month: 9,
    weekday: 0,
    nth: 3,
    offset_days: -1,
    start: '15:00',
    duration_min: 180,
    timezone: 'Asia/Manila',
  },
};
const choices: DialogueChoice[] = [
  {
    id: 'cheer',
    kind: 'talk',
    profile: 'procession-cheer',
    delivery: 'utterance',
    speakers: [0],
    turns: 1,
  },
  {
    id: 'hello',
    kind: 'greet',
    period: 'afternoon',
    profile: 'greeting',
    delivery: 'utterance',
    speakers: [0],
    turns: 1,
  },
];
it.each([false, true])(
  'targets ground procession people by stable owner (inspection=%s)',
  (inspection) => {
    const pm = 1 / metersPerUnit(left);
    const start = tileToLngLat(left, { x: 1000, y: 2000 });
    const street: StreetRoute = {
      ...route,
      kind: 'procession',
      formation: undefined,
      route: [start, tileToLngLat(left, { x: 1000 + 100 * pm, y: 2000 })],
      length_m: 100,
      segments: [{ id: 'osm:way/1', width_m: 14, sidewalk_m: 2 }],
      blocked: [],
    };
    const builder = new LifeBuilder();
    builder.line(
      [
        { x: 0, y: 2000 },
        { x: 4096, y: 2000 },
      ],
      LifeLine.roadMinor,
      14,
      1,
    );
    const world = new LifeWorld(undefined, undefined, { dialogue: choices }, inspection);
    world.enableTaps();
    world.setProcessions([street]);
    world.sync([{ key: 'road', tile: left, life: builder.finish() }]);
    const life = world.resident('road')!;
    life.movers.length = life.parked.length = life.stalls.length = life.gatherers.length = 0;
    world.setLive(street.id, 0.5, '2026');
    world.step(0.1, undefined, 19);
    const agents = world.visible(19, 1, start);
    const index = agents.findIndex((a) => a.event && a.kind === 'person' && !a.prop && !a.aboard);
    expect(index).toBeGreaterThanOrEqual(0);
    const selected = agents[index]!;
    const tap: LifeTap = {
      id: 1,
      generation: 1,
      frame: world.tapSources!.frame,
      agent: index,
      at: [selected.lng, selected.lat],
      pointer: 'touch',
      cellMeters: 1,
    };
    const firstOwner = world.tapSources!.read(tap)!.target!.owner;
    const refreshed = world.visible(19, 1, start);
    const nextIndex = refreshed.findIndex(
      (a) =>
        a.lng === selected.lng && a.lat === selected.lat && a.kind === selected.kind && a.event,
    );
    expect(
      world.tapSources!.read({ frame: world.tapSources!.frame, agent: nextIndex })!.target!.owner,
    ).toBe(firstOwner);
    world.step(
      0,
      undefined,
      19,
      undefined,
      undefined,
      { minutes: 720, rain: 0 },
      1,
      1.8,
      1,
      undefined,
      undefined,
      undefined,
      [tap],
    );
    expect(world.tapReceipts).toEqual([{ id: 1, action: 'agent' }]);
    expect(
      world.visible(19, 1, start).filter((a) => a.speech?.exchangeId === 'hello'),
    ).toHaveLength(1);
  },
);
function eventWorld(
  played = false,
  inspection = false,
  catalog: readonly DialogueChoice[] = choices,
) {
  const world = new LifeWorld(undefined, undefined, { dialogue: catalog }, inspection);
  world.enableTaps();
  world.setProcessions([route]);
  if (played) {
    world.play(route.id);
    const duration = new ProcessionScene(route).playDuration / 2;
    for (let t = 0; t < duration; t += 0.1) world.step(0.1, undefined, 19);
  } else world.setLive(route.id, 0.5, '2026');
  const agents = world.visible(19, 1, [0, 0]);
  const pagoda = agents.find((a) => a.vehicle === 'pagoda')!;
  const tap: LifeTap = {
    id: 1,
    generation: 1,
    frame: world.tapSources!.frame,
    at: [pagoda.lng, pagoda.lat],
    cellMeters: 1,
    pointer: 'touch',
  };
  return { world, tap, agents };
}
it('reuses the sourced pack cheer and preserves requested speech over ambient event cues', () => {
  const catalog: DialogueChoice[] = [
    ...choices.filter((choice) => choice.profile !== 'procession-cheer'),
    {
      id: 'pack-cheer',
      kind: 'cheer',
      conditions: { occasions: ['fluvial'] },
      delivery: 'utterance',
      speakers: [0],
      turns: 1,
    },
  ];
  const cues = vi.spyOn(EventCues, 'assignEventCues').mockImplementation((agents) => {
    for (const agent of agents)
      if (agent.kind === 'person' && !agent.aboard && !agent.prop)
        agent.speech = { id: 'ambient', exchangeId: 'background', line: 0 };
  });
  try {
    const f = eventWorld(false, false, catalog);
    f.world.step(
      0,
      undefined,
      19,
      undefined,
      undefined,
      undefined,
      1,
      1.8,
      1,
      undefined,
      undefined,
      undefined,
      [f.tap],
    );
    const visible = f.world.visible(19, 1, [0, 0]);
    expect(visible.filter((agent) => agent.speech?.exchangeId === 'pack-cheer')).toHaveLength(1);
    const requestedEmoji = visible.filter((agent) => agent.emoji?.id.startsWith('emoji:'));
    expect(requestedEmoji.length).toBeGreaterThan(0);
    expect(requestedEmoji.every((agent) => !agent.speech)).toBe(true);
    expect(visible.some((agent) => agent.speech?.exchangeId === 'background')).toBe(true);
    expect(catalog.find((choice) => choice.id === 'pack-cheer')).toMatchObject({
      kind: 'cheer',
      conditions: { occasions: ['fluvial'] },
    });
  } finally {
    cues.mockRestore();
  }
});
it('does not request a street-only chant during a fluvial event', () => {
  const catalog: DialogueChoice[] = [
    {
      id: 'street-only',
      kind: 'cheer',
      conditions: { occasions: ['procession'] },
      delivery: 'utterance',
      speakers: [0],
      turns: 1,
    },
  ];
  const f = eventWorld(false, false, catalog);
  f.world.step(
    0,
    undefined,
    19,
    undefined,
    undefined,
    undefined,
    1,
    1.8,
    1,
    undefined,
    undefined,
    undefined,
    [f.tap],
  );
  expect(f.world.tapReceipts).toEqual([{ id: 1, action: 'procession' }]);
  expect(f.world.visible(19, 1, [0, 0]).some((a) => a.speech?.id.startsWith('scene:'))).toBe(false);
});
it.each([false, true])(
  'cheers through stable owners without physical movers (played=%s)',
  (played) => {
    const f = eventWorld(played);
    const react = vi.spyOn(EventTaps.prototype, 'react');
    f.world.step(
      0,
      undefined,
      19,
      undefined,
      undefined,
      { minutes: 960, rain: 0 },
      1,
      1.8,
      1,
      undefined,
      undefined,
      undefined,
      [f.tap],
    );
    expect(f.world.tapReceipts).toEqual([{ id: 1, action: 'procession' }]);
    expect(react).toHaveBeenCalledTimes(8);
    expect(new Set(react.mock.calls.map((c) => c[0])).size).toBe(8);
    const visible = f.world.visible(19, 1, [0, 0]);
    expect(visible.filter((a) => a.speech?.exchangeId === 'cheer')).toHaveLength(1);
    expect(visible.filter((a) => a.emoji?.mood === 'festive').length).toBeGreaterThan(0);
    expect(visible.filter((a) => a.emoji?.id.startsWith('emoji:')).length).toBeLessThanOrEqual(4);
    expect(f.world.size).toBe(0);
    expect(f.world.visible(19, 1, [0, 0]).filter((a) => a.speech)).toHaveLength(1);
    react.mockRestore();
  },
);
it('clears event presentation on occurrence replacement and removal', () => {
  const f = eventWorld();
  f.world.step(
    0,
    undefined,
    19,
    undefined,
    undefined,
    undefined,
    1,
    1.8,
    1,
    undefined,
    undefined,
    undefined,
    [f.tap],
  );
  f.world.setLive(route.id, 0.5, '2027');
  expect(
    f.world
      .visible(19, 1, [0, 0])
      .some((a) => a.emoji?.id.startsWith('emoji:') || a.speech?.id.startsWith('scene:')),
  ).toBe(false);
  f.world.setLive(undefined);
  expect(f.world.visible(19, 1, [0, 0]).some((a) => a.event)).toBe(false);
});
it('retires idle event tap state and recreates it for the next request', () => {
  const f = eventWorld();
  const step = vi.spyOn(EventTaps.prototype, 'step');
  try {
    f.world.step(
      0,
      undefined,
      19,
      undefined,
      undefined,
      undefined,
      1,
      1.8,
      1,
      undefined,
      undefined,
      undefined,
      [f.tap],
    );
    expect(f.world.visible(19, 1, [0, 0]).some((a) => a.speech?.id.startsWith('scene:'))).toBe(
      true,
    );
    f.world.step(9, undefined, 19);
    f.world.visible(19, 1, [0, 0]);
    f.world.step(0.1, undefined, 19);
    step.mockClear();
    f.world.visible(19, 1, [0, 0]);
    f.world.step(0.1, undefined, 19);
    expect(step).not.toHaveBeenCalled();
    f.world.visible(19, 1, [0, 0]);
    f.world.step(
      0,
      undefined,
      19,
      undefined,
      undefined,
      undefined,
      1,
      1.8,
      1,
      undefined,
      undefined,
      undefined,
      [{ ...f.tap, id: 2, frame: f.world.tapSources!.frame }],
    );
    expect(step).toHaveBeenCalledOnce();
    expect(f.world.visible(19, 1, [0, 0]).some((a) => a.speech?.id.startsWith('scene:'))).toBe(
      true,
    );
  } finally {
    step.mockRestore();
  }
});
it.each([false, true])(
  'greets a tapped event person and defers its wave (inspection=%s)',
  (inspection) => {
    const f = eventWorld(false, inspection);
    const index = f.agents.findIndex((a) => a.event && a.kind === 'person' && !a.prop && !a.aboard);
    const target = f.agents[index]!;
    f.world.step(
      0,
      undefined,
      19,
      undefined,
      undefined,
      { minutes: 720, rain: 0 },
      1,
      1.8,
      1,
      undefined,
      undefined,
      undefined,
      [{ ...f.tap, agent: index, at: [target.lng, target.lat] }],
    );
    expect(
      f.world.visible(19, 1, [0, 0]).filter((a) => a.speech?.exchangeId === 'hello'),
    ).toHaveLength(1);
    f.world.step(3.1, undefined, 19);
    expect(f.world.visible(19, 1, [0, 0]).some((a) => a.emoji?.mood === 'wave')).toBe(true);
  },
);
it('declines a distant tap or an event that is not running', () => {
  const f = eventWorld();
  f.world.step(
    0,
    undefined,
    19,
    undefined,
    undefined,
    undefined,
    1,
    1.8,
    1,
    undefined,
    undefined,
    undefined,
    [{ ...f.tap, at: [1, 1] }],
  );
  expect(f.world.tapReceipts).toEqual([{ id: 1 }]);
  f.world.setLive(undefined);
  f.world.visible(19, 1, [0, 0]);
  f.world.step(
    0,
    undefined,
    19,
    undefined,
    undefined,
    undefined,
    1,
    1.8,
    1,
    undefined,
    undefined,
    undefined,
    [{ ...f.tap, frame: f.world.tapSources!.frame }],
  );
  expect(f.world.tapReceipts).toEqual([{ id: 1 }]);
});
it('consumes a distant crowd tap only while its event is running', () => {
  const f = eventWorld();
  f.world.step(
    0,
    undefined,
    19,
    undefined,
    undefined,
    undefined,
    1,
    1.8,
    1,
    undefined,
    undefined,
    undefined,
    [{ ...f.tap, crowd: true, at: [1, 1], firework: true }],
  );
  expect(f.world.tapReceipts).toEqual([{ id: 1, action: 'procession' }]);
  expect(f.world.visible(19, 1, [0, 0]).some((a) => a.speech?.id.startsWith('scene:'))).toBe(false);
  f.world.setLive(undefined);
  f.world.visible(19, 1, [0, 0]);
  f.world.step(
    0,
    undefined,
    19,
    undefined,
    undefined,
    undefined,
    1,
    1.8,
    1,
    undefined,
    undefined,
    undefined,
    [{ ...f.tap, frame: f.world.tapSources!.frame, crowd: true, firework: true }],
  );
  expect(f.world.tapReceipts).toEqual([{ id: 1 }]);
});
