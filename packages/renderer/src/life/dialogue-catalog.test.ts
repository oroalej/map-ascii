import { expect, it } from 'vitest';
import { loadCityPacks } from '@atlas/content';
import { dialogueChoices, SCENE_PROFILES } from '@atlas/shared';
import { Moments, type MomentActor, type MomentContext } from './moments';
import { SceneSpeech } from './scene-speech';
import { dialogueEligible, type DialogueContext } from './dialogue';
import { assignEventCues, eventCheers } from './event-cues';
import type { VisibleAgent } from './simulate';

// loadCityPacks reads the packs from disk; this lets targeted runs select the test on dialogue edits.
import.meta.glob('../../../content/cities/*/dialogue.json');
const { packs, errors } = await loadCityPacks();
if (errors.length) throw new Error(JSON.stringify(errors));
const entries = packs.flatMap(({ city, dialogue }) =>
  dialogue
    ? dialogueChoices(dialogue).map((entry) => ({
        city: city.slug,
        periods: dialogue.periods,
        entry,
      }))
    : [],
);
const choices = entries.map(({ entry }) => entry);
// Event cheers are called out by running events (event-cues.ts), not by street moments.
const cheers = entries.filter(({ entry }) => entry.kind === 'cheer');

it.each(cheers)('$city/$entry.id is called out by each of its events', ({ entry }) => {
  const byEvent = eventCheers(choices);
  const people = Array.from({ length: 200 }, (_, i): VisibleAgent => ({
    kind: 'person',
    lng: 0,
    lat: 0,
    flap: 0,
    candleSeed: i,
  }));
  for (const occasion of entry.conditions!.occasions!) {
    expect(byEvent[occasion]).toContain(entry.id);
    const said = new Set<string>();
    for (let clock = 0; clock < 600; clock += 3) {
      for (const person of people) delete person.speech;
      assignEventCues(people, occasion, clock, { cheers: byEvent[occasion], emoji: true });
      for (const person of people) if (person.speech) said.add(person.speech.exchangeId);
    }
    expect(said).toContain(entry.id);
  }
});
it.each(entries.filter(({ entry }) => entry.kind !== 'cheer'))(
  '$city/$entry.id can emit every intended turn with its declared roles and legal context',
  ({ entry, periods }) => {
    const weather = entry.conditions?.weather;
    const rainScene = ['rain', 'heavy-rain', 'easing'].includes(weather ?? '');
    const sceneOwned =
      rainScene ||
      weather === 'heat' ||
      weather === 'clearing' ||
      SCENE_PROFILES.includes(entry.profile!);
    const slots = Math.max(2, ...(entry.speakers ?? []).map((slot) => slot + 1));
    const owners = Array.from({ length: slots }, () => ({}));
    const context: DialogueContext = {
      minutes:
        entry.period === 'morning'
          ? 480
          : entry.period === 'evening' || weather === 'evening-calm'
            ? 1200
            : 720,
      rain: rainScene ? 0.9 : 0,
      sheltered: rainScene || weather === 'clearing',
      shaded: weather === 'heat',
      clearing: weather === 'clearing',
      sunAltitude: 60,
      easing: weather === 'easing',
      arrival: entry.conditions?.event === 'arrival',
      wind: weather === 'breeze' ? 0.7 : weather === 'gust' ? 1 : 0,
      place: entry.profile === 'school' ? 'school' : entry.kind === 'ball' ? 'pitch' : 'monument',
      anchors: [entry.conditions?.anchor ?? 'monument'],
      figures:
        entry.conditions?.audience === 'adult-child' ? ['adult', 'child'] : ['adult', 'adult'],
      ...(sceneOwned && { profiles: [entry.profile!] }),
    };
    context.figures = Array.from({ length: slots }, (_, i) => context.figures[i] ?? 'adult');
    // Search the pack's legal clock window rather than assuming Naga's period boundaries.
    const minutes = Array.from({ length: 1440 }, (_, minute) => minute).find((minute) =>
      dialogueEligible(entry, { ...context, minutes: minute }, periods),
    );
    expect(minutes).toBeDefined();
    context.minutes = minutes!;
    expect(dialogueEligible(entry, context, periods)).toBe(true);
    const seen = new Map<number, number>();
    if (sceneOwned) {
      const host = new SceneSpeech(42, [entry], periods);
      const scene = {
        key: {},
        speakers: owners.map((owner, i) => ({ owner, member: 0, figure: context.figures[i]! })),
        profiles: [entry.profile!],
        context,
        valid: () => true,
      };
      if (
        entry.delivery === 'utterance' &&
        !['vendor-thanks', 'companion'].includes(entry.profile!)
      )
        scene.speakers = scene.speakers.slice(0, 1);
      expect(host.admit(scene, 12)).toBe(true);
      for (let tick = 0; tick < 2200 && seen.size < entry.turns; tick++) {
        owners.forEach((owner, slot) => {
          const cue = host.speech(owner);
          if (cue) seen.set(cue.line, slot);
        });
        host.step(0.1, true);
        if (!host.size) host.admit({ ...scene, key: {} }, 12);
      }
    } else {
      const a: MomentActor = {
        owner: owners[0]!,
        type: entry.kind === 'greet' || entry.kind === 'look' ? 'walker' : 'gatherer',
        x: 0,
        y: 0,
        hx: 1,
        hy: 0,
        figure: entry.kind === 'ball' ? 'child' : 'adult',
        idle: entry.kind !== 'greet',
        place: context.place as MomentActor['place'],
        source: 0,
      };
      const b: MomentActor = { ...a, owner: owners[1]!, x: entry.kind === 'greet' ? 2 : 6, hx: -1 };
      const actors =
        entry.kind === 'look'
          ? [a]
          : [a, b, ...(slots > 2 ? [{ ...a, owner: owners[2]!, x: 3, y: 5 }] : [])];
      const c: MomentContext = {
        zoom: 21,
        rain: context.rain,
        minutes: context.minutes,
        wind: context.wind,
        perMeter: 1,
        actors: () => actors,
        anchors: [{ x: 8, y: 0, source: 0, kind: context.anchors![0]! }],
        eligible: () => true,
        clearance: () => 0.5,
        face: () => true,
        release: () => {},
      };
      const host = new Moments(42, true, () => 0, [entry], periods);
      for (let tick = 0; tick < 2200; tick++) {
        host.step(0.1, c);
        actors.forEach((actor, slot) => {
          const cue = host.speech(actor.owner);
          if (cue && !seen.has(cue.line)) seen.set(cue.line, slot);
        });
        if (seen.size === entry.turns) break;
      }
    }
    expect([...seen.keys()].sort()).toEqual(Array.from({ length: entry.turns }, (_, i) => i));
    if (entry.kind !== 'ball')
      for (const [line, slot] of seen) expect(slot).toBe(entry.speakers![line]);
  },
);

it('never enables school, vendor, transit or sheltered scripts for an ordinary monument pair', () => {
  const context: DialogueContext = {
    minutes: 720,
    rain: 0,
    wind: 0.25,
    place: 'monument',
    anchors: ['monument'],
    figures: ['adult', 'adult'],
  };
  const selected = choices.filter((entry) => dialogueEligible(entry, context));
  expect(
    selected.some((e) =>
      ['school', 'vendor-order', 'vendor-thanks', 'transit', 'companion'].includes(e.profile!),
    ),
  ).toBe(false);
  expect(
    selected.some((e) => ['rain', 'heavy-rain', 'easing'].includes(e.conditions?.weather ?? '')),
  ).toBe(false);
});
