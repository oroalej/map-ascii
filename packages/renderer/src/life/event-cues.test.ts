import { expect, it } from 'vitest';
import { assignEventCues, EVENT_CUES, EVENT_MOODS, eventCheers } from './event-cues';
import { identifyEventActor } from './event-actors';
import type { VisibleAgent } from './simulate';

const people = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    identifyEventActor<VisibleAgent>(
      { kind: 'person', lng: 0, lat: 0, flap: 0 },
      `procession/test/devotee/${i}`,
    ),
  );
const cues = (agents: VisibleAgent[]) =>
  agents.map((a) => (a.speech ? `say ${a.speech.exchangeId}` : a.emoji ? a.emoji.mood : '-'));
const clear = (agents: VisibleAgent[]) => {
  for (const a of agents) {
    delete a.speech;
    delete a.emoji;
  }
};

it('gives a small, rotating share of an event’s people its moods and cheers', () => {
  const crowd = people(2000),
    cheers = ['cheer-a', 'cheer-b'];
  assignEventCues(crowd, 'procession', 100, { cheers, emoji: true });
  const first = cues(crowd);
  const reacting = first.filter((c) => c !== '-').length / crowd.length;
  expect(reacting).toBeGreaterThan(EVENT_CUES.share * 0.6);
  expect(reacting).toBeLessThan(EVENT_CUES.share * 1.4);
  const spoken = first.filter((c) => c.startsWith('say ')).length;
  expect(spoken).toBeGreaterThan(0);
  expect(spoken).toBeLessThan(first.filter((c) => c !== '-').length);
  expect(new Set(first.filter((c) => c.startsWith('say ')))).toEqual(
    new Set(['say cheer-a', 'say cheer-b']),
  );
  const moods = new Set(EVENT_MOODS.procession.map((m) => m.mood));
  expect(
    first.filter((c) => c !== '-' && !c.startsWith('say ')).every((c) => moods.has(c as never)),
  ).toBe(true);
  // The same moment always gives the same cues; a cue lasts its turn, then others react.
  clear(crowd);
  assignEventCues(crowd, 'procession', 100, { cheers, emoji: true });
  expect(cues(crowd)).toEqual(first);
  clear(crowd);
  assignEventCues(crowd, 'procession', 100.5, { cheers, emoji: true });
  const soon = cues(crowd);
  expect(soon.filter((c, i) => c === first[i]).length).toBeGreaterThan(crowd.length * 0.9);
  clear(crowd);
  assignEventCues(crowd, 'procession', 100 + EVENT_CUES.window * 3, { cheers, emoji: true });
  expect(cues(crowd)).not.toEqual(first);
});

it('leaves objects, crews, vehicles and unidentified people alone, and respects emoji off', () => {
  const others: VisibleAgent[] = [
    identifyEventActor({ kind: 'person', lng: 0, lat: 0, flap: 0, prop: 'event', glyph: '#' }, 'a'),
    identifyEventActor({ kind: 'person', lng: 0, lat: 0, flap: 0, aboard: true }, 'b'),
    identifyEventActor({ kind: 'vehicle', lng: 0, lat: 0, flap: 0, vehicle: 'car' }, 'c'),
    { kind: 'person', lng: 0, lat: 0, flap: 0 },
  ];
  for (let clock = 0; clock < 600; clock += 1)
    assignEventCues(others, 'parade', clock, { cheers: ['cheer-a'], emoji: true });
  expect(others.every((a) => !a.speech && !a.emoji)).toBe(true);
  // Without emoji, only the cheers remain; without cheers either, nothing.
  const crowd = people(2000);
  assignEventCues(crowd, 'mass', 40, { cheers: ['cheer-amen'], emoji: false });
  expect(crowd.some((a) => a.speech)).toBe(true);
  expect(crowd.some((a) => a.emoji)).toBe(false);
  clear(crowd);
  assignEventCues(crowd, 'mass', 40, { cheers: [], emoji: false });
  expect(crowd.some((a) => a.speech || a.emoji)).toBe(false);
});

it('keys river bank people by their candle seed', () => {
  const bank = Array.from({ length: 2000 }, (_, i): VisibleAgent => ({
    kind: 'person',
    lng: 0,
    lat: 0,
    flap: 0,
    candleSeed: i * 7919,
  }));
  assignEventCues(bank, 'fluvial', 12, { cheers: [], emoji: true });
  const moods = new Set(EVENT_MOODS.fluvial.map((m) => m.mood));
  const shown = bank.filter((a) => a.emoji);
  expect(shown.length).toBeGreaterThan(0);
  expect(
    shown.every((a) => moods.has(a.emoji!.mood) && a.emoji!.id.startsWith('event:seed:')),
  ).toBe(true);
});

it('collects each event’s cheers from the dialogue choices', () => {
  const byEvent = eventCheers([
    { id: 'look-x', kind: 'look', turns: 1 },
    {
      id: 'cheer-v',
      kind: 'cheer',
      turns: 1,
      conditions: { occasions: ['procession', 'fluvial'] },
    },
    { id: 'cheer-amen', kind: 'cheer', turns: 1, conditions: { occasions: ['mass'] } },
  ]);
  expect(byEvent).toEqual({
    procession: ['cheer-v'],
    fluvial: ['cheer-v'],
    parade: [],
    mass: ['cheer-amen'],
  });
});
