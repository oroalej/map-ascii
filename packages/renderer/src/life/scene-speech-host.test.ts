import { describe, expect, it, vi } from 'vitest';
import type { DialogueChoice } from '@atlas/shared';
import { LifeBuilder, LifeLine } from './geometry';
import { TileLife, type Mover, type Stall, type Walker } from './simulate';
import type { Visit } from './interactions';
import { SceneSpeechHost } from './scene-speech-host';

const member: Walker = {
  figure: 'adult',
  shirt: 2,
  umbrella: 1,
  canopy: 0,
  lateral: 0,
  back: 0,
  step: 0,
};
function fixture(choice: DialogueChoice) {
  const builder = new LifeBuilder();
  builder.line(
    [
      { x: 0, y: 1000 },
      { x: 4095, y: 1000 },
    ],
    LifeLine.path,
  );
  const tile = new TileLife({ z: 16, x: 55192, y: 30266 }, builder.finish(), 5);
  const exemplar = tile.movers.find((m) => m.kind === 'person')!;
  const person: Mover = {
    ...exemplar,
    x: 1000,
    y: 1000,
    hx: 1,
    hy: 0,
    group: [{ ...member }],
    rank: 0,
    pause: 1,
  };
  tile.movers.splice(0, tile.movers.length, person);
  tile.stalls.length = 0;
  const vendor: Stall = {
    x: 1000,
    y: 1020,
    hx: 1,
    hy: 0,
    rank: 0,
    paint: 0,
    shirt: 1,
    side: 1,
    open: true,
  };
  tile.stalls.push(vendor);
  tile.scenes.addStall(vendor);
  const site = tile.scenes.sites.find((s) => s.stall === vendor && s.kind === 'vendor')!;
  const visit: Visit = {
    site,
    state: 'purchase',
    path: [],
    trail: [],
    next: 0,
    time: 3,
    seat: 0,
    sheltering: false,
    blocked: 0,
  };
  tile.scenes.visits.set(person, visit);
  site.queue.push(person);
  const host = new SceneSpeechHost(tile, 1, { dialogue: [choice] });
  return { tile, person, vendor, site, visit, host };
}
const order: DialogueChoice = {
  id: 'order',
  kind: 'talk',
  profile: 'vendor-order',
  turns: 2,
  speakers: [0, 1],
};
describe('real local-scene adapters', () => {
  const weather = (condition: 'heat' | 'clearing'): DialogueChoice => ({
    id: condition,
    kind: 'talk',
    profile: 'weather',
    conditions: { weather: condition },
    speakers: [0, 1],
    turns: 2,
  });
  it.each(['shade', 'stop'] as const)(
    'admits hot shade speech at a %s site and cancels when weather or visits change',
    (kind) => {
      const f = fixture(weather('heat'));
      f.site.kind = kind;
      f.visit.state = 'shade';
      f.visit.time = 30;
      f.person.group!.push({ ...member, lateral: 1 });
      f.host.step(0.1, 21, { rain: 0, minutes: 720, sunAltitude: 60 }, undefined, []);
      expect(f.host.speech.speech(f.person)?.exchangeId).toBe('heat');
      f.host.step(0, 21, { rain: 0, minutes: 720, sunAltitude: 40 }, undefined, []);
      expect(f.host.speech.size).toBe(0);
    },
  );
  it.each([false, true])(
    'bounds shade speech by all participant dwells in arrival and ordinary scans (event=%s)',
    (event) => {
      const f = fixture(weather('heat'));
      f.site.kind = 'shade';
      f.visit.state = 'shade';
      f.visit.time = 30;
      const partner = { ...f.person, group: [{ ...member }], x: 1010 };
      const secondVisit = { ...f.visit, time: 2 };
      f.tile.movers.push(partner);
      f.site.queue.push(partner);
      f.tile.scenes.visits.set(partner, secondVisit);
      if (event)
        f.tile.scenes.speechEvents.push({
          kind: 'shade',
          mover: f.person,
          visit: f.visit,
          key: {},
        });
      const admit = vi.spyOn(f.host.speech, 'admit');
      f.host.step(0.1, 21, { rain: 0, minutes: 720, sunAltitude: 60 }, undefined, []);
      expect(admit.mock.calls[0]![0].remaining).toBe(2);
      expect(f.host.speech.size).toBe(0);
      f.tile.scenes.speechEvents.length = 0;
      f.person.group!.push({ ...member, lateral: 1 });
      f.tile.movers.splice(1);
      f.site.queue.splice(1);
      f.host.clear();
      f.host.step(0.1, 21, { rain: 0, minutes: 720, sunAltitude: 60 }, undefined, []);
      expect(f.host.speech.size).toBe(1); // Group members share the longer Visit.
      f.tile.scenes.visits.set(f.person, { ...f.visit });
      f.host.step(0, 21, { rain: 0, minutes: 720, sunAltitude: 60 }, undefined, []);
      expect(f.host.speech.size).toBe(0);
    },
  );
  it('dispatches clearing by site despite a departed invisible event mover, excluding missing and stale countdowns', () => {
    const f = fixture(weather('clearing'));
    f.site.kind = 'shelter';
    f.site.covered = true;
    f.visit.state = 'return';
    const people = [undefined, 50, 9, 40, 25].map((leave, i) => ({
      ...f.person,
      x: 1100 + i * 10,
      group: [{ ...member }],
    }));
    const visits = people.map((p, i) => ({
      ...f.visit,
      state: 'shelter' as const,
      sheltering: true,
      leave: [undefined, 50, 9, 40, 25][i],
      leaveShower: i === 1 ? 0 : 1,
    }));
    people.forEach((p, i) => {
      f.tile.movers.push(p);
      f.site.queue.push(p);
      f.tile.scenes.visits.set(p, visits[i]!);
    });
    const before = visits.map((v) => v.leave);
    f.tile.scenes.speechEvents.push({
      kind: 'clearing',
      mover: f.person,
      visit: f.visit,
      key: {},
      shower: 1,
    });
    const admit = vi.spyOn(f.host.speech, 'admit');
    const near = (x: number) => x !== f.person.x;
    f.host.step(0.1, 21, { rain: 0 }, near, []);
    const scene = admit.mock.calls[0]![0];
    expect(scene.speakers.map((s) => s.owner)).toEqual([people[3], people[4]]);
    expect(scene.remaining).toBe(25);
    expect(f.host.speech.speech(people[3]!)).toMatchObject({ exchangeId: 'clearing', line: 0 });
    expect(visits.map((v) => v.leave)).toEqual(before);
    f.tile.scenes.speechEvents.length = 0;
    f.host.step(0, 21, { rain: 1 }, near, []);
    expect(f.host.speech.size).toBe(0);
  });
  it.each(['short', 'shower', 'return'] as const)(
    'refuses or cancels clearing on %s participant lifetime changes without extending stays',
    (change) => {
      const f = fixture(weather('clearing'));
      f.site.kind = 'shelter';
      f.site.covered = true;
      f.visit.state = 'shelter';
      f.visit.sheltering = true;
      f.visit.leave = change === 'short' ? 2 : 20;
      f.visit.leaveShower = 1;
      f.person.group!.push({ ...member, lateral: 1 });
      f.host.step(0.1, 21, { rain: 0 }, undefined, []);
      expect(f.host.speech.size).toBe(0); // Ordinary scans never synthesize clearing.
      f.tile.scenes.speechEvents.push({
        kind: 'clearing',
        mover: f.person,
        visit: f.visit,
        key: {},
        shower: 1,
      });
      f.host.step(0.1, 21, { rain: 0 }, undefined, []);
      expect(f.host.speech.size).toBe(change === 'short' ? 0 : 1);
      expect(f.visit.leave).toBe(change === 'short' ? 2 : 20);
      f.tile.scenes.speechEvents.length = 0;
      if (change === 'shower') f.visit.leaveShower = 2;
      if (change === 'return') f.visit.returnPending = true;
      f.host.step(0, 21, { rain: 0 }, undefined, []);
      expect(f.host.speech.size).toBe(0);
    },
  );
  const happy: DialogueChoice = {
    id: 'happy',
    kind: 'talk',
    profile: 'daily-plans',
    delivery: 'utterance',
    turns: 1,
    speakers: [0],
  };
  it.each([30, 60, 120])('keeps 80 background scans over eight seconds at %i Hz', (hz) => {
    const f = fixture(happy);
    f.tile.scenes.visits.clear();
    const attempt = vi
      .spyOn(f.host.speech.selector.memory, 'ambientAttempt')
      .mockReturnValue(false);
    for (let tick = 0; tick < 8 * hz; tick++)
      f.host.step(1 / hz, 21, { rain: 0, clock: (tick + 1) / hz }, undefined, []);
    expect(attempt).toHaveBeenCalledTimes(80);
  });
  it('does not bank adapter credits between scan deadlines', () => {
    const f = fixture(order);
    const admit = vi.spyOn(f.host.speech, 'admit');
    for (let i = 0; i < 10; i++)
      f.tile.scenes.speechEvents.push({
        kind: 'purchase',
        mover: f.person,
        visit: f.visit,
        key: {},
      });
    f.host.step(0.01, 21, { rain: 0 }, undefined, []);
    expect(admit).toHaveBeenCalledTimes(2);
    f.host.step(0.01, 21, { rain: 0 }, undefined, []);
    expect(admit).toHaveBeenCalledTimes(2);
    f.host.step(0.08, 21, { rain: 0 }, undefined, []);
    expect(admit).toHaveBeenCalledTimes(4);
  });
  it('lets one walker express themselves without holding or changing navigation', () => {
    const f = fixture(happy);
    f.tile.scenes.visits.clear();
    f.person.pause = 0;
    const before = structuredClone(f.person);
    let spoken = false;
    for (let tick = 0; tick < 40; tick++) {
      f.host.step(60, 21, { rain: 0, clock: tick * 60, minutes: 720 }, undefined, []);
      if (!f.host.speech.speech(f.person)) continue;
      spoken = true;
      expect(f.host.speech.speech(f.person)).toMatchObject({
        exchangeId: 'happy',
        line: 0,
        member: 0,
      });
      expect(f.host.speech.pose(f.person, 0)).toBeUndefined();
      expect(f.host.speech.busy(f.person)).toBe(false);
      expect(f.person).toEqual(before);
      f.host.step(3, 21, { rain: 0, clock: tick * 60 + 3 }, undefined, []);
      expect(f.host.speech.speech(f.person)).toBeUndefined();
      break;
    }
    expect(spoken).toBe(true);
  });
  it('preserves a silent rest gesture and lets a purchase cancel the expression', () => {
    const f = fixture(happy);
    f.tile.scenes.visits.clear();
    let silent = false;
    for (let tick = 0; tick < 40; tick++) {
      f.host.step(60, 21, { rain: 0, clock: tick * 60 }, undefined, []);
      if (!f.host.speech.size || f.host.speech.speech(f.person)) continue;
      silent = true;
      expect(f.host.speech.pose(f.person, 0)).toBe('gesture');
      const before = structuredClone(f.person);
      f.tile.scenes.visits.set(f.person, f.visit);
      f.tile.scenes.speechEvents.push({
        kind: 'purchase',
        mover: f.person,
        visit: f.visit,
        key: {},
      });
      f.host.step(0.02, 21, { rain: 0, clock: tick * 60 + 0.02 }, undefined, []);
      expect(f.host.speech.size).toBe(0);
      expect(f.visit.time).toBe(3);
      expect(f.person).toEqual(before);
      break;
    }
    expect(silent).toBe(true);
  });
  it('lets a solitary school gatherer speak without changing the existing activity', () => {
    const builder = new LifeBuilder();
    builder.place({ x: 1000, y: 1000 }, 'school', 20);
    const tile = new TileLife({ z: 16, x: 55192, y: 30266 }, builder.finish(), 5);
    const person = tile.gatherers[0]!;
    expect(person).toBeDefined();
    tile.gatherers.splice(1);
    tile.movers.length = 0;
    tile.stalls.length = 0;
    const host = new SceneSpeechHost(tile, 1, {
      dialogue: [{ ...happy, id: 'school', profile: 'school' }],
    });
    const before = structuredClone(person);
    let spoken = false;
    for (let tick = 0; tick < 40; tick++) {
      host.step(60, 21, { rain: 0, clock: tick * 60 }, undefined, []);
      if (!host.speech.speech(person)) continue;
      spoken = true;
      expect(host.speech.speech(person)).toMatchObject({ exchangeId: 'school', member: 0 });
      expect(person).toEqual(before);
      host.step(0.02, 21, { rain: 0, clock: tick * 60 + 0.02 }, () => false, []);
      expect(host.speech.size).toBe(0);
      break;
    }
    expect(spoken).toBe(true);
  });
  it('lets a lone transit passenger react only to a real arrival', () => {
    const f = fixture({
      ...happy,
      id: 'arrival',
      profile: 'transit',
      conditions: { event: 'arrival' },
    });
    f.site.kind = 'stop';
    f.visit.state = 'wait';
    f.host.step(0.1, 21, { rain: 0 }, undefined, []);
    expect(f.host.speech.size).toBe(0);
    f.tile.scenes.speechEvents.push({ kind: 'arrival', mover: f.person, visit: f.visit, key: {} });
    f.host.step(0.02, 21, { rain: 0 }, undefined, []);
    expect(f.host.speech.size).toBe(1);
    expect(f.host.speech.selector.selected.arrival).toBe(1);
    f.visit.state = 'board';
    f.host.step(0, 21, { rain: 0 }, undefined, []);
    expect(f.host.speech.speech(f.person)).toBeUndefined();
    f.host.step(0.02, 21, { rain: 0 }, undefined, []);
    expect(f.host.speech.size).toBe(0);
  });
  it('reserves a check for a purchase beginning between background scans', () => {
    const f = fixture(order);
    f.tile.scenes.visits.clear();
    f.host.step(0.1, 21, { rain: 0 }, undefined, []);
    expect(f.host.speech.size).toBe(0);
    f.tile.scenes.visits.set(f.person, f.visit);
    f.tile.scenes.speechEvents.push({ kind: 'purchase', mover: f.person, visit: f.visit, key: {} });
    f.host.step(0.02, 21, { rain: 0 }, undefined, []);
    expect(f.host.speech.speech(f.person)).toMatchObject({ exchangeId: 'order', line: 0 });
    expect(f.visit.time).toBe(3);
  });
  it('observes a purchase without changing any scene state or navigation fields', () => {
    const f = fixture(order);
    f.tile.scenes.speechEvents.push({ kind: 'purchase', mover: f.person, visit: f.visit, key: {} });
    const before = structuredClone({ person: f.person, visit: f.visit, vendor: f.vendor });
    f.host.step(0.1, 21, { rain: 0 }, undefined, []);
    expect(f.host.speech.speech(f.person)?.line).toBe(0);
    f.tile.scenes.speechEvents.length = 0;
    f.host.step(1.5, 21, { rain: 0 }, undefined, []);
    expect(f.host.speech.speech(f.vendor)?.line).toBe(1);
    expect({ person: f.person, visit: f.visit, vendor: f.vendor }).toEqual(before);
    f.visit.state = 'return';
    f.host.step(0, 21, { rain: 0 }, undefined, []);
    expect(f.host.speech.speech(f.vendor)).toBeUndefined();
  });
  it('speaks from an actual waiting companion, with arrival required and boarding taking precedence', () => {
    const f = fixture({
      id: 'arrival',
      kind: 'talk',
      profile: 'transit',
      conditions: { event: 'arrival' },
      speakers: [0, 1],
      turns: 2,
    });
    f.site.kind = 'stop';
    f.visit.state = 'wait';
    f.person.group!.push({ ...member, lateral: 1 });
    f.host.step(0.1, 21, { rain: 0 }, undefined, []);
    expect(f.host.speech.size).toBe(0);
    f.tile.scenes.speechEvents.push({ kind: 'arrival', mover: f.person, visit: f.visit, key: {} });
    f.host.step(0.1, 21, { rain: 0 }, undefined, []);
    expect(f.host.speech.speech(f.person)?.line).toBe(0);
    f.tile.scenes.speechEvents.length = 0;
    f.host.step(3, 21, { rain: 0 }, undefined, []);
    expect(f.host.speech.speech(f.person)).toMatchObject({ line: 1, member: 1 });
    f.visit.state = 'board';
    f.host.step(0, 21, { rain: 0 }, undefined, []);
    expect(f.host.speech.speech(f.person)).toBeUndefined();
  });
  it('admits sheltered weather dialogue and clears it when the shelter visit ends', () => {
    const f = fixture({
      id: 'rain',
      kind: 'talk',
      profile: 'weather',
      conditions: { weather: 'rain' },
      speakers: [0, 1],
      turns: 2,
    });
    f.site.kind = 'shelter';
    f.site.covered = true;
    f.visit.state = 'shelter';
    f.visit.sheltering = true;
    f.person.group!.push({ ...member, lateral: 1 });
    f.host.step(0.1, 21, { rain: 1 }, undefined, []);
    expect(f.host.speech.speech(f.person)?.exchangeId).toBe('rain');
    f.host.step(0.1, 21, { rain: 0 }, undefined, []);
    expect(f.host.speech.size).toBe(0);
  });
  it('cancels invisible speakers and does not attach companion replies to another group', () => {
    const f = fixture({
      id: 'call',
      kind: 'talk',
      profile: 'companion',
      speakers: [0, 1],
      turns: 2,
    });
    f.tile.scenes.visits.clear();
    f.person.group!.push({ ...member, figure: 'child', lateral: 1 });
    const before = structuredClone(f.person);
    f.host.step(0.1, 21, { rain: 0 }, undefined, []);
    expect(f.host.speech.speech(f.person)?.member).toBe(0);
    expect(f.person).toEqual(before);
    f.host.step(0.1, 21, { rain: 0 }, () => false, []);
    expect(f.host.speech.size).toBe(0);
  });
});
