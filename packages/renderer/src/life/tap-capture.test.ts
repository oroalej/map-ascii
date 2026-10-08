import { expect, it, vi } from 'vitest';
import { classId } from '../classes';
import { CellBit } from './config';
import { captureTap, type TapCaptureFrame } from './tap-capture';
import type { LifeTap } from './tap';
function fixture() {
  const callbacks: ((bytes: Uint8Array) => void)[] = [];
  const reads = {
    size: 0,
    request: vi.fn((_fbo, _attachment, _rect, done: (bytes: Uint8Array) => void) => {
      callbacks.push(done);
    }),
  };
  const frame: TapCaptureFrame = {
    targets: {
      cols: 1,
      rows: 1,
      glyphFbo: {},
      sub: { fbo: {} } as TapCaptureFrame['targets']['sub'],
    },
    grid: { shiftX: 0, shiftY: 0, cellWidth: 10, cellHeight: 18 },
    dpr: 1,
    geometry: 'one',
    owners: new Uint32Array([1]),
    life: new Uint8Array([0, classId('life_person'), CellBit.person, 0]),
    agents: [{ kind: 'person', lng: 0, lat: 0, flap: 0 }],
    labelsCover: () => false,
    generation: 1,
    frame: 1,
    folklore: [],
  };
  const tap: Omit<LifeTap, 'id'> = {
    generation: 1,
    frame: 1,
    at: [0, 0],
    pointer: 'touch',
    cellMeters: 1,
  };
  const done = vi.fn<Parameters<typeof captureTap>[6]>();
  let valid = true;
  const start = () => captureTap([5, 5], tap, frame, reads, 100, () => valid, done);
  const finish = (cls = 'path', height = 0) =>
    callbacks
      .splice(0)
      .forEach((callback, i) =>
        callback(
          new Uint8Array(
            i === 0 ? [0, classId(cls), 0, 0] : [i === 1 ? classId(cls) : height, 0, 0, 0],
          ),
        ),
      );
  return {
    frame,
    reads,
    done,
    start,
    finish,
    invalidate: () => {
      valid = false;
    },
  };
}
it('targets touch without hover or any owner selection', () => {
  const f = fixture();
  f.start();
  f.finish();
  expect(f.done).toHaveBeenCalledWith(expect.objectContaining({ pointer: 'touch', agent: 0 }));
  expect(f.frame.agents[0]!.inspectionId).toBeUndefined();
});
it.each(['building_part', 'building', 'tree_crown'])(
  'candle admission matches the shader burial exception on %s',
  (cls) => {
    const f = fixture(),
      done = vi.fn<Parameters<typeof captureTap>[6]>();
    f.frame.owners.fill(0);
    captureTap(
      [5, 5],
      {
        generation: 1,
        frame: 1,
        at: [0, 0],
        pointer: 'touch',
        cellMeters: 1,
        candle: { key: 'candle', at: [0, 0] },
        signal: { seed: 1, midBlock: false },
      },
      f.frame,
      f.reads,
      100,
      () => true,
      done,
    );
    f.finish(cls, 5);
    expect(done.mock.calls[0]![0].candle !== undefined).toBe(cls === 'building_part');
    expect(done.mock.calls[0]![0].signal).toBeUndefined();
  },
);
it.each(['path', 'tree_crown', 'building'])(
  'admits signal hardware only on its visible %s surface',
  (cls) => {
    const f = fixture();
    f.frame.owners.fill(0);
    const done = vi.fn<Parameters<typeof captureTap>[6]>();
    captureTap(
      [5, 5],
      {
        generation: 1,
        frame: 1,
        at: [0, 0],
        pointer: 'touch',
        cellMeters: 1,
        signal: { seed: 0, midBlock: false },
      },
      f.frame,
      f.reads,
      100,
      () => true,
      done,
    );
    expect(f.reads.request).toHaveBeenCalledTimes(3);
    f.finish(cls, cls === 'path' ? 0 : 5);
    expect(done.mock.calls[0]![0].signal !== undefined).toBe(cls === 'path');
  },
);
it.each(['tree_crown', 'building'])('a %s occluder cannot claim the agent', (cls) => {
  const f = fixture();
  f.start();
  f.finish(cls, 5);
  expect(f.done).toHaveBeenCalledWith(expect.not.objectContaining({ agent: 0 }));
});
it('drops labels, stale geometry and rejected reads', () => {
  const f = fixture();
  f.frame.labelsCover = () => true;
  f.start();
  expect(f.reads.request).not.toHaveBeenCalled();
  f.frame.labelsCover = () => false;
  f.start();
  f.invalidate();
  f.finish();
  expect(f.done).not.toHaveBeenCalled();
});
