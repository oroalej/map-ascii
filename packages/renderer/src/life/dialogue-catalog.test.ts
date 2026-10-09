import { expect, it } from 'vitest';
import { loadCityPacks } from '@atlas/content';
import { dialogueChoices, SCENE_PROFILES } from '@atlas/shared';
import { Moments, type MomentActor, type MomentContext } from './moments';
import { SceneSpeech } from './scene-speech';
import { dialogueEligible, type DialogueContext } from './dialogue';
import { peddlerFixture, peddlerConfig, peddlerWeather, peddlerPM } from './testing/peddlers';
import { LifeBuilder, LifeLine } from './geometry';
import { PeddlerCaller } from './peddler-calls';
import { assignEventCues, eventCheers } from './event-cues';
import type { VisibleAgent } from './simulate';

// loadCityPacks reads the packs from disk; this lets targeted runs select the test on dialogue edits.
import.meta.glob('../../../content/cities/*/dialogue.json');
import.meta.glob('../../../content/cities/*/city.json');
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

it.each(['heat', 'clearing', 'hover'] as const)(
  'excludes sales-only dialogue for the actual buyer in %s',
  (mode) => {
    const street = new LifeBuilder();
    street.line(
      [
        { x: 1000, y: 1500 },
        { x: 1000 + 100 * peddlerPM, y: 1500 },
      ],
      LifeLine.roadMinor,
      6,
    );
    const pack = packs.find(({ city }) => city.slug === 'naga')!,
      buyer = pack.city.life!.peddlers!.find(({ id }) => id === 'bote-dyaryo')!,
      catalog = dialogueChoices(pack.dialogue!),
      { population } = peddlerFixture([{ ...buyer, share: 1 }], street.finish());
    population.step(0, { ...peddlerWeather, minutes: 540 }, 0);
    const owner = population.owners[0]!,
      caller = new PeddlerCaller(catalog, pack.dialogue!.periods),
      env = { ...peddlerWeather, minutes: 780, sunAltitude: 60 };
    expect(owner).toBeDefined();
    const context: DialogueContext = {
      minutes: 780,
      rain: 0,
      wind: 0,
      sunAltitude: 60,
      clearing: mode === 'clearing',
      figures: ['adult'],
      profiles: ['peddler-call'],
      delivery: 'utterance',
      peddler: { goods: buyer.id, event: mode === 'hover' ? 'hover' : undefined },
    };
    for (const id of ['peddler-heat-tired', 'peddler-clearing', 'peddler-hover-1'])
      expect(
        dialogueEligible(
          catalog.find((entry) => entry.id === id)!,
          context,
          pack.dialogue!.periods,
        ),
      ).toBe(false);
    for (let i = 0; i < 4; i++) {
      owner.callToken++;
      if (mode === 'clearing') owner.resumeToken++;
      caller.step(owner, 10, env, true, mode === 'hover' && i === 0);
      if (mode === 'hover' && i === 0)
        expect(caller.cue(owner)?.exchangeId).toBe('peddler-hover-2');
      else expect(caller.cue(owner)?.exchangeId).toMatch(/^peddler-bote-dyaryo-/);
    }
  },
);

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
      ...(entry.profile === 'peddler-call' && {
        peddler: {
          goods: entry.conditions?.goods?.[0] ?? 'sample-goods',
          event: entry.conditions?.event as 'hover' | 'leaving' | undefined,
        },
      }),
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
    if (entry.profile === 'peddler-call') {
      const { population } = peddlerFixture([{ ...peddlerConfig, id: context.peddler!.goods }]);
      population.step(0, peddlerWeather, 0);
      const owner = population.owners[0]!;
      const caller = new PeddlerCaller([entry], periods);
      caller.step(
        owner,
        0,
        { ...peddlerWeather, ...context, wind: { dir: [1, 0], strength: context.wind } },
        true,
        false,
      );
      owner.callToken++;
      owner.resumeToken += Number(weather === 'clearing');
      owner.leaving = context.peddler!.event === 'leaving';
      caller.step(
        owner,
        0,
        { ...peddlerWeather, ...context, wind: { dir: [1, 0], strength: context.wind } },
        true,
        context.peddler!.event === 'hover',
      );
      const cue = caller.cue(owner);
      expect(cue?.exchangeId).toBe(entry.id);
      seen.set(cue!.line, cue!.member!);
      expect(dialogueEligible(entry, { ...context, peddler: undefined }, periods)).toBe(false);
      if (entry.conditions?.goods)
        expect(
          dialogueEligible(
            entry,
            { ...context, peddler: { ...context.peddler!, goods: 'unrelated-goods' } },
            periods,
          ),
        ).toBe(false);
      if (entry.conditions?.event)
        expect(
          dialogueEligible(
            entry,
            { ...context, peddler: { ...context.peddler!, event: undefined } },
            periods,
          ),
        ).toBe(false);
    } else if (sceneOwned) {
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
