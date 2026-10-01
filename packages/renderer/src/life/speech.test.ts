import { describe, expect, it, vi } from 'vitest';
import { classId } from '../classes';
import type { ReadRect } from '../readback';
import { CellBit } from './config';
import { SpeechController, type SpeechFrame, type SpeechInView } from './speech';
import { lifeVisibleOnSurface } from './surface-visibility';

function fixture() {
  const queue: ((data: Uint8Array) => void)[] = [],
    events: SpeechInView[][] = [];
  const readback = {
    size: 0,
    request: vi.fn(
      (
        _fbo: WebGLFramebuffer,
        _attachment: number,
        _rect: ReadRect,
        done: (data: Uint8Array) => void,
      ) => {
        queue.push(done);
      },
    ),
  };
  const frame: SpeechFrame = {
    targets: {
      cols: 20,
      rows: 20,
      glyphFbo: {},
      sub: { fbo: {} } as SpeechFrame['targets']['sub'],
    },
    grid: { shiftX: 0, shiftY: 0, cellWidth: 10, cellHeight: 18 },
    dpr: 1,
    geometry: 'initial',
    owners: new Uint32Array(400),
    life: new Uint8Array(1600),
    agents: [
      {
        kind: 'person',
        lng: 10.5,
        lat: 10.5,
        flap: 0,
        speech: { id: 'speaker', exchangeId: 'greet', line: 0 },
      },
    ],
    toCell: (lng, lat) => [lng, lat],
    size: { width: 800, height: 600 },
    labelsCover: () => false,
  };
  frame.owners[210] = 1;
  frame.life[210 * 4 + 1] = classId('life_person');
  frame.life[210 * 4 + 2] = CellBit.person;
  const controller = new SpeechController(readback, 10, (event) => events.push(event));
  const finish = (surface = 'paving', height = 0) => {
    const batch = queue.splice(0, 3);
    batch[0]?.(new Uint8Array([0, classId(surface), 0, 0]));
    batch[1]?.(new Uint8Array([classId(surface), 0, 0, 0]));
    batch[2]?.(new Uint8Array([height, 0, 0, 0]));
  };
  return { frame, queue, events, readback, controller, finish };
}
describe('speech visibility', () => {
  it.each([
    [800, 3, 6],
    [500, 2, 4],
  ])('caps bubbles and visibility candidates at viewport width %s', (width, limit, candidates) => {
    const f = fixture();
    f.frame.size.width = width;
    f.frame.owners.fill(0);
    f.frame.agents = Array.from({ length: 8 }, (_, i) => ({
      kind: 'person',
      lng: i + 1.5,
      lat: 10.5,
      flap: 0,
      speech: { id: `speaker-${i}`, exchangeId: 'greet', line: 0 },
    }));
    f.frame.agents.forEach((_, i) => {
      const cell = 201 + i;
      f.frame.owners[cell] = i + 1;
      f.frame.life[cell * 4 + 1] = classId('life_person');
      f.frame.life[cell * 4 + 2] = CellBit.person;
    });
    for (let i = 0; i < 10; i++) {
      f.controller.update(f.frame, i * 10);
      f.finish();
    }
    expect(f.events.at(-1)).toHaveLength(limit);
    expect(f.events.every((event) => event.length <= limit)).toBe(true);
    expect(f.readback.request).toHaveBeenCalledTimes(candidates * 3);
  });
  it('publishes only after one asynchronous three-read batch and keeps CSS anchors at fractional DPR', () => {
    const f = fixture();
    f.frame.dpr = 1.5;
    f.controller.update(f.frame, 0);
    expect(f.events).toEqual([]);
    expect(f.readback.request).toHaveBeenCalledTimes(3);
    f.finish();
    f.controller.update(f.frame, 20);
    expect(f.events.at(-1)).toEqual([
      { id: 'speaker', exchangeId: 'greet', line: 0, point: [70, 126] },
    ]);
    expect(f.readback.request).toHaveBeenCalledTimes(3);
  });
  it.each(['tree', 'trees', 'tree_crown', 'building', 'water_area'])(
    'rejects a speaker under %s',
    (surface) => {
      const f = fixture();
      f.controller.update(f.frame, 0);
      f.finish(surface, 10);
      f.controller.update(f.frame, 20);
      expect(f.events.flat()).toEqual([]);
    },
  );
  it('admits church/school grounds only at zero height and ignores the signal bit', () => {
    const person = classId('life_person'),
      school = classId('building_school');
    expect(lifeVisibleOnSurface(person, CellBit.person | 128, school, school, 0)).toBe(true);
    expect(lifeVisibleOnSurface(person, CellBit.person, school, school, 1)).toBe(false);
    expect(lifeVisibleOnSurface(person, 128, classId('paving'), classId('paving'), 0)).toBe(false);
  });
  it('does not query rejected, label-covered or offscreen actors, or exceed the shared queue', () => {
    for (const block of ['owner', 'label', 'edge', 'queue']) {
      const f = fixture();
      if (block === 'owner') f.frame.owners.fill(0);
      if (block === 'label') f.frame.labelsCover = () => true;
      if (block === 'edge') f.frame.size = { width: 50, height: 50 };
      if (block === 'queue') f.readback.size = 6;
      f.controller.update(f.frame, 0);
      expect(f.readback.request).not.toHaveBeenCalled();
    }
  });
  it('discards geometry/speaker changes and incomplete old batches, and clears synchronously', () => {
    const f = fixture();
    f.controller.update(f.frame, 0);
    const stale = f.queue.splice(0);
    f.frame.geometry = 'new';
    f.controller.update(f.frame, 20);
    for (const done of stale) done(new Uint8Array([classId('paving'), classId('paving'), 0, 0]));
    expect(f.events).toEqual([]);
    f.finish();
    f.controller.update(f.frame, 40);
    expect(f.events.at(-1)).toHaveLength(1);
    f.controller.clear();
    expect(f.events.at(-1)).toEqual([]);
    f.controller.update(f.frame, 50);
    const old = f.queue.splice(0);
    f.controller.update(f.frame, 310);
    for (const done of old) done(new Uint8Array([classId('paving'), classId('paving'), 0, 0]));
    expect(f.events.at(-1)).toEqual([]);
    f.frame.agents[0]!.speech = undefined;
    f.finish();
    f.controller.update(f.frame, 320);
    expect(f.events.at(-1)).toEqual([]);
  });
  it('keeps different maps independent', () => {
    const a = fixture(),
      b = fixture();
    a.controller.update(a.frame, 0);
    b.controller.update(b.frame, 0);
    a.finish();
    a.controller.update(a.frame, 20);
    expect(a.events.at(-1)).toHaveLength(1);
    expect(b.events).toEqual([]);
    b.finish('tree_crown');
    b.controller.update(b.frame, 20);
    expect(b.events).toEqual([]);
  });
});
