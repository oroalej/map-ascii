import { describe, expect, it, vi } from 'vitest';
import { classId } from '../classes';
import type { ReadRect } from '../readback';
import { CellBit } from './config';
import { CueReadback } from './cue-readback';
import { EmojiController, type EmojiInView } from './emoji-view';
import { SpeechController, type SpeechFrame, type SpeechInView } from './speech';
import type { VisibleAgent } from './simulate';

function fixture(agents: VisibleAgent[], width = 800) {
  let now = 0;
  const queue: {
    done: (data: Uint8Array) => void;
    retire?: () => void;
    at: number;
    slot: number;
    rect: ReadRect;
  }[] = [];
  const reads = {
    get size() {
      return queue.length;
    },
    request: (
      _f: WebGLFramebuffer,
      _a: number,
      rect: ReadRect,
      done: (b: Uint8Array) => void,
      retire?: () => void,
    ) => queue.push({ done, retire, at: now, slot: queue.length % 3, rect }),
  };
  const frame: SpeechFrame = {
    targets: { cols: 80, rows: 60, glyphFbo: {}, sub: { fbo: {} } as never },
    grid: { cellWidth: 10, cellHeight: 10, shiftX: 0, shiftY: 0 },
    dpr: 1,
    geometry: 'a',
    owners: new Uint32Array(4800),
    life: new Uint8Array(19200),
    speakers: { members: new Uint8Array(4800), points: new Map() },
    agents,
    toCell: (x, y) => [x, y],
    size: { width, height: 600 },
    labelsCover: () => false,
  };
  agents.forEach((a, i) => {
    const at = Math.floor(a.lat) * 80 + Math.floor(a.lng);
    frame.owners[at] = i + 1;
    frame.speakers!.members[at] = a.kind === 'person' ? 1 : 0;
    frame.life[at * 4 + 1] = classId(a.kind === 'vehicle' ? 'life_vehicle' : 'life_person');
    frame.life[at * 4 + 2] = a.kind === 'vehicle' ? CellBit.vehicle : CellBit.person;
    frame.speakers!.points.set(i + 1, [a.lng, a.lat]);
  });
  const emojiEvents: EmojiInView[][] = [],
    speechEvents: SpeechInView[][] = [];
  let points: readonly (readonly [number, number])[] = [];
  const arbiter = new CueReadback();
  const emoji = new EmojiController(
    reads,
    10,
    (c) => emojiEvents.push(c),
    () => now,
    arbiter,
    () => points,
  );
  const speech = new SpeechController(
    reads,
    10,
    (c) => {
      speechEvents.push(c);
      points = c.map((s) => s.point);
    },
    () => now,
    arbiter,
  );
  const tick = (time: number, delay = 0, withEmoji = true) => {
    now = time;
    while (queue[0] && queue[0].at + delay <= now) {
      const q = queue.shift()!;
      q.done(
        q.slot === 0
          ? new Uint8Array([0, classId('road_minor'), 0, 0])
          : q.slot === 1
            ? new Uint8Array([classId('road_minor'), 0, 0, 0])
            : new Uint8Array(4),
      );
      q.retire?.();
    }
    speech.update(frame, now);
    if (withEmoji) emoji.update(frame, now);
  };
  return { frame, emoji, speech, emojiEvents, speechEvents, queue, arbiter, tick };
}
const dog = (id: string, x: number, y = 30, pair?: string): VisibleAgent => ({
  kind: 'dog',
  lng: x,
  lat: y,
  flap: 0,
  emoji: { id, subject: 'dog', mood: 'happy', pair },
});
describe('production cue wrappers', () => {
  it('confirms a bird fear bubble from its painted owner without person speaker metadata', () => {
    const f = fixture([
      {
        kind: 'bird',
        lng: 30,
        lat: 30,
        flap: 0,
        emoji: { id: 'fear', subject: 'bird', mood: 'scared' },
      },
    ]);
    const at = 30 * 80 + 30;
    f.frame.life[at * 4 + 1] = classId('life_bird');
    f.frame.life[at * 4 + 2] = CellBit.bird;
    f.frame.speakers = undefined;
    f.tick(0);
    f.tick(16);
    expect(f.emojiEvents.at(-1)).toEqual([
      expect.objectContaining({ id: 'fear', subject: 'bird', mood: 'scared' }),
    ]);
  });
  it('includes lease wait in confirmation latency while GPU budgeting measures issued reads only', () => {
    const f = fixture([dog('mood', 30)]);
    const release = f.arbiter.acquire('speech', 0)!;
    const sampled = vi.spyOn(f.arbiter, 'completed');
    f.tick(0);
    expect(f.queue).toHaveLength(0);
    release();
    f.tick(200);
    expect(f.queue).toHaveLength(3);
    f.tick(400);
    expect(f.emojiEvents.at(-1)).toHaveLength(1);
    const scheduling = f.emoji as unknown as { latencies: Float64Array; maxLatency: number };
    expect(scheduling.latencies[0]).toBe(400);
    expect(scheduling.maxLatency).toBe(400);
    expect(sampled).toHaveBeenCalledExactlyOnceWith(200);
    sampled.mockRestore();
  });
  it.each(['speech', 'emoji'] as const)(
    'keeps unexpired %s evidence after a dropped recheck without renewing expiry or sampling latency',
    (kind) => {
      const speaker: VisibleAgent = {
        kind: 'person',
        lng: 30,
        lat: 30,
        flap: 0,
        speech: { id: 'speaker', exchangeId: 'hello', line: 0 },
      };
      const f = fixture([kind === 'speech' ? speaker : dog('mood', 30)]);
      const sampled = vi.spyOn(f.arbiter, 'completed');
      const scheduling = f[kind] as unknown as {
        latencies: Float64Array;
        latencyCursor: number;
        maxLatency: number;
      };
      const events = kind === 'speech' ? f.speechEvents : f.emojiEvents;
      f.tick(0);
      f.tick(200);
      expect(events.at(-1)).toHaveLength(1);
      const latencies = scheduling.latencies.slice();
      const cursor = scheduling.latencyCursor;
      const maximum = scheduling.maxLatency;
      f.tick(600);
      f.tick(601, 1000);
      const rejected = f.queue.splice(0);
      expect(rejected).toHaveLength(3);
      rejected[0]!.retire?.();
      expect(f.arbiter.busy).toBe(true);
      f.tick(602);
      expect(events.at(-1)).toHaveLength(1);
      expect(scheduling.latencies).toEqual(latencies);
      expect(scheduling.latencyCursor).toBe(cursor);
      expect(scheduling.maxLatency).toBe(maximum);
      expect(sampled).toHaveBeenCalledTimes(1);
      for (const request of rejected.slice(1)) request.retire?.();
      expect(f.arbiter.busy).toBe(false);
      f.tick(1199, 10_000);
      expect(events.at(-1)).toHaveLength(1);
      f.tick(1200, 10_000);
      expect(events.at(-1)).toEqual([]);
      sampled.mockRestore();
    },
  );
  it('uses explicit leader order with nonnumeric IDs even when the reply is closer to center', () => {
    const leader = dog('leader', 10, 30, 'pair');
    const reply = dog('reply', 40, 30, 'pair');
    leader.emoji!.order = 0;
    reply.emoji!.order = 1;
    const pair = fixture([reply, leader], 600);
    pair.tick(0);
    expect(pair.queue[0]!.rect.x).toBe(10);
    pair.tick(20);
    pair.tick(40);
    expect(pair.emojiEvents.at(-1)?.map((cue) => cue.id)).toEqual(['leader', 'reply']);
    const ranked = fixture([reply, leader, dog('solo', 30)], 600);
    for (let time = 0; time <= 600; time += 20) ranked.tick(time);
    expect(ranked.emojiEvents.at(-1)?.map((cue) => cue.id)).toEqual(['solo']);
  });
  it.each([1, 2])(
    'preserves two-speaker rotation after %s refused emoji-lease frames',
    (refusals) => {
      const speakers: VisibleAgent[] = [35, 50].map((x, i) => ({
        kind: 'person',
        lng: x,
        lat: 30,
        flap: 0,
        speech: { id: `s${i + 1}`, exchangeId: 'hello', line: 0 },
      }));
      const baseline = fixture([...speakers, dog('mood', 15)]);
      const mixed = fixture([...speakers, dog('mood', 15)]);
      for (const f of [baseline, mixed]) {
        for (const time of [0, 20, 40]) f.tick(time, 0, false);
        expect(f.speechEvents.at(-1)).toHaveLength(2);
      }
      baseline.tick(500, 0, false);
      const nextSpeakerCell = baseline.queue[0]!.rect.x;
      mixed.tick(100);
      expect(mixed.queue).toHaveLength(3);
      for (let i = 0; i < refusals; i++) mixed.tick(500 + i * 20, 1000, false);
      const releasedAt = 500 + refusals * 20;
      mixed.tick(releasedAt, 0, false);
      expect(mixed.queue[0]!.rect.x).toBe(nextSpeakerCell);
      expect(mixed.speechEvents.at(-1)?.map((cue) => cue.id)).toEqual(
        baseline.speechEvents.at(-1)?.map((cue) => cue.id),
      );
      for (let time = releasedAt + 20; time <= 1500; time += 20) {
        baseline.tick(time, 20, false);
        mixed.tick(time, 20);
        expect(mixed.speechEvents.at(-1)).toHaveLength(baseline.speechEvents.at(-1)!.length);
      }
    },
  );
  it('accepts pets and moving vehicles with one physical batch and 4/2 caps', () => {
    for (const width of [800, 600]) {
      const f = fixture(
        [
          dog('1', 15),
          dog('2', 25),
          dog('3', 35),
          dog('4', 45),
          {
            kind: 'vehicle',
            vehicle: 'car',
            lng: 55,
            lat: 30,
            flap: 0,
            emoji: { id: '5', subject: 'driver', mood: 'cool' },
          },
        ],
        width,
      );
      for (let t = 0; t < 1000; t += 20) {
        f.tick(t);
        expect(f.queue.length).toBeLessThanOrEqual(3);
      }
      expect(f.emojiEvents.at(-1)).toHaveLength(width === 800 ? 4 : 2);
    }
  });
  it('confirms both pair halves before atomic publication, and retires a missing half', () => {
    const f = fixture([dog('emoji:0:2', 30, 30, 'pair'), dog('emoji:0:3', 33, 30, 'pair')], 600);
    f.tick(0);
    f.tick(100, 100);
    expect(f.emojiEvents.flat()).toHaveLength(0);
    f.tick(200, 100);
    expect(f.emojiEvents.at(-1)).toHaveLength(2);
    f.frame.agents = [f.frame.agents[0]!];
    f.tick(220, 100);
    expect(f.emojiEvents.at(-1)).toEqual([]);
  });
  it.each(['visible', 'offscreen', 'unpainted'])(
    'rejects a malformed three-member pair even when its third member is %s',
    (visibility) => {
      const third = dog('third', visibility === 'offscreen' ? 0 : 40, 30, 'pair');
      const f = fixture([dog('leader', 30, 30, 'pair'), dog('reply', 33, 30, 'pair'), third]);
      if (visibility === 'unpainted') f.frame.owners[30 * 80 + 40] = 0;
      f.tick(0);
      f.tick(20);
      expect(f.queue).toHaveLength(0);
      expect(f.emojiEvents.flat()).toHaveLength(0);
    },
  );
  it('spreads other groups while exempting partners and requires a vendor human cell', () => {
    const f = fixture([dog('1', 35), dog('2', 39), dog('3', 55)]);
    for (let t = 0; t <= 300; t += 20) f.tick(t);
    expect(f.emojiEvents.at(-1)).toHaveLength(2);
    const vendor: VisibleAgent = {
      kind: 'person',
      vehicle: 'cart',
      lng: 30,
      lat: 30,
      flap: 0,
      emoji: { id: 'vendor', subject: 'person', mood: 'happy' },
    };
    const v = fixture([vendor]);
    v.frame.speakers!.members.fill(0);
    v.tick(0);
    expect(v.queue).toHaveLength(0);
  });
  it('keeps a cleared or timed-out batch leased until its three reads settle', () => {
    const f = fixture([dog('1', 30)]);
    f.tick(0);
    f.emoji.clear();
    expect(f.arbiter.busy).toBe(true);
    f.tick(1100, 2000);
    expect(f.queue).toHaveLength(3);
    f.frame.geometry = 'b';
    f.tick(1200, 2000);
    expect(f.queue).toHaveLength(3);
    const first = f.queue.shift()!;
    first.retire?.();
    expect(f.arbiter.busy).toBe(true);
    for (const q of f.queue.splice(0)) q.retire?.();
    expect(f.arbiter.busy).toBe(false);
    f.tick(1300);
    f.tick(1320);
    expect(f.emojiEvents.at(-1)).toHaveLength(1);
  });
  it.each([100, 200, 800])(
    'adds no speech expiry gaps relative to the speech-only baseline at %s ms',
    (delay) => {
      const speaker: VisibleAgent = {
        kind: 'person',
        lng: 20,
        lat: 20,
        flap: 0,
        speech: { id: 'speech', exchangeId: 'hello', line: 0 },
      };
      const baseline = fixture([speaker, dog('1', 50)]),
        mixed = fixture([speaker, dog('1', 50)]);
      let emojiProgress = false;
      for (let t = 0; t <= 5000; t += 20) {
        baseline.tick(t, delay, false);
        mixed.tick(t, delay);
        expect(mixed.speechEvents.at(-1)?.length ?? 0).toBeGreaterThanOrEqual(
          baseline.speechEvents.at(-1)?.length ?? 0,
        );
        emojiProgress ||= (mixed.emojiEvents.at(-1)?.length ?? 0) > 0;
        expect(mixed.queue.length).toBeLessThanOrEqual(3);
      }
      if (delay <= 200) expect(emojiProgress).toBe(true);
    },
  );
});
