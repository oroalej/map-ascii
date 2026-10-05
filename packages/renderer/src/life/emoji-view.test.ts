import { describe, expect, it } from 'vitest';
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
  }[] = [];
  const reads = {
    get size() {
      return queue.length;
    },
    request: (
      _f: WebGLFramebuffer,
      _a: number,
      _r: ReadRect,
      done: (b: Uint8Array) => void,
      retire?: () => void,
    ) => queue.push({ done, retire, at: now, slot: queue.length % 3 }),
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
