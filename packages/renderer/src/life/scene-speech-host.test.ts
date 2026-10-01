import { describe, expect, it } from 'vitest';
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
