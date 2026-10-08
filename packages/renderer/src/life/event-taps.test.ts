import { expect, it, vi } from 'vitest';
import type { DialogueChoice, FluvialRoute } from '@atlas/shared';
import { LifeWorld } from './simulate';
import { EventTaps } from './event-taps';
import { ProcessionScene } from './procession';
import type { LifeTap } from './tap';

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
function eventWorld(played = false, inspection = false) {
  const world = new LifeWorld(undefined, undefined, { dialogue: choices }, inspection);
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
      [f.tap],
    );
    expect(f.world.tapReceipts).toEqual([{ id: 1, action: 'procession' }]);
    expect(react).toHaveBeenCalledTimes(8);
    expect(new Set(react.mock.calls.map((c) => c[0])).size).toBe(8);
    const visible = f.world.visible(19, 1, [0, 0]);
    expect(visible.filter((a) => a.speech?.exchangeId === 'cheer')).toHaveLength(1);
    expect(visible.filter((a) => a.emoji?.mood === 'festive').length).toBeGreaterThan(0);
    expect(visible.filter((a) => a.emoji).length).toBeLessThanOrEqual(4);
    expect(f.world.size).toBe(0);
    expect(f.world.visible(19, 1, [0, 0]).filter((a) => a.speech)).toHaveLength(1);
    react.mockRestore();
  },
);
it('clears event presentation on occurrence replacement and removal', () => {
  const f = eventWorld();
  f.world.step(0, undefined, 19, undefined, undefined, undefined, 1, 1.8, 1, undefined, [f.tap]);
  f.world.setLive(route.id, 0.5, '2027');
  expect(f.world.visible(19, 1, [0, 0]).some((a) => a.emoji || a.speech)).toBe(false);
  f.world.setLive(undefined);
  expect(f.world.visible(19, 1, [0, 0]).some((a) => a.event)).toBe(false);
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
  f.world.step(0, undefined, 19, undefined, undefined, undefined, 1, 1.8, 1, undefined, [
    { ...f.tap, at: [1, 1] },
  ]);
  expect(f.world.tapReceipts).toEqual([{ id: 1 }]);
  f.world.setLive(undefined);
  f.world.visible(19, 1, [0, 0]);
  f.world.step(0, undefined, 19, undefined, undefined, undefined, 1, 1.8, 1, undefined, [
    { ...f.tap, frame: f.world.tapSources!.frame },
  ]);
  expect(f.world.tapReceipts).toEqual([{ id: 1 }]);
});
