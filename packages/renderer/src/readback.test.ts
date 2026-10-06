import { describe, expect, it, vi } from 'vitest';
import type { GL } from './gpu';
import { Picker, type PickResult } from './picking';
import { MAX_PENDING_READS, Readback } from './readback';
import { SpeechController, type SpeechFrame } from './life/speech';
import { CellBit } from './life/config';
import { classId } from './classes';

/** A fake WebGL2 context: reads fill the buffer with `value`, fences signal on `signal()`. */
function fakeGl() {
  const signaled = new Set<object>();
  const deleted: object[] = [];
  let value: number[] = [0, 0, 0, 0];
  const gl = {
    READ_FRAMEBUFFER: 1,
    PIXEL_PACK_BUFFER: 2,
    RGBA: 3,
    UNSIGNED_BYTE: 4,
    SYNC_GPU_COMMANDS_COMPLETE: 5,
    SYNC_STATUS: 6,
    SIGNALED: 7,
    UNSIGNALED: 8,
    STREAM_READ: 9,
    COLOR_ATTACHMENT2: 10,
    bindFramebuffer: vi.fn(),
    readBuffer: vi.fn(),
    bindBuffer: vi.fn(),
    bufferData: vi.fn(),
    createBuffer: vi.fn(() => ({})),
    deleteBuffer: vi.fn(),
    readPixels: vi.fn(),
    flush: vi.fn(),
    fenceSync: vi.fn(() => ({})),
    deleteSync: vi.fn((sync: object) => deleted.push(sync)),
    getSyncParameter: vi.fn((sync: object) => (signaled.has(sync) ? 7 : 8)),
    getBufferSubData: vi.fn((_target: number, _offset: number, out: Uint8Array) => {
      for (let i = 0; i < out.length; i++) out[i] = value[i % 4]!;
    }),
  };
  return {
    gl: gl as unknown as GL,
    raw: gl,
    deleted,
    /** Signal every fence created so far. */
    signal() {
      for (const result of gl.fenceSync.mock.results) signaled.add(result.value as object);
    },
    setValue(v: number[]) {
      value = v;
    },
  };
}

const fbo = {} as WebGLFramebuffer;
const rect = { x: 3, y: 4, width: 1, height: 1 };

describe('Readback', () => {
  it.each([false, true])(
    'notifies retirement on reset(lost=%s), rejection and success exactly once',
    (lost) => {
      const f = fakeGl(),
        readback = new Readback(f.gl),
        done = vi.fn(),
        retired = vi.fn();
      readback.request(fbo, 10, { ...rect, width: 0 }, done, retired);
      expect(retired).toHaveBeenCalledTimes(1);
      expect(done).not.toHaveBeenCalled();
      f.raw.fenceSync.mockReturnValueOnce(null as unknown as object);
      readback.request(fbo, 10, rect, done, retired);
      expect(retired).toHaveBeenCalledTimes(2);
      readback.request(fbo, 10, rect, done, retired);
      readback.reset(lost);
      expect(retired).toHaveBeenCalledTimes(3);
      expect(readback.size).toBe(0);
      readback.request(fbo, 10, rect, done, retired);
      f.signal();
      readback.poll();
      expect(done).toHaveBeenCalledTimes(1);
      expect(retired).toHaveBeenCalledTimes(4);
      readback.reset();
      expect(retired).toHaveBeenCalledTimes(4);
    },
  );
  it('hands the data over only once the fence has signaled', () => {
    const f = fakeGl();
    const readback = new Readback(f.gl);
    const done = vi.fn();
    f.setValue([1, 2, 3, 4]);
    readback.request(fbo, 10, rect, done);
    expect(f.raw.readPixels).toHaveBeenCalledWith(3, 4, 1, 1, 3, 4, 0);
    readback.poll();
    expect(done).not.toHaveBeenCalled();
    expect(f.raw.getBufferSubData).not.toHaveBeenCalled();
    f.signal();
    readback.poll();
    expect(done).toHaveBeenCalledWith(new Uint8Array([1, 2, 3, 4]));
    expect(readback.size).toBe(0);
  });

  it('delivers reads in order, and reuses pack buffers', () => {
    const f = fakeGl();
    const readback = new Readback(f.gl);
    const order: number[] = [];
    readback.request(fbo, 10, rect, () => order.push(1));
    readback.request(fbo, 10, rect, () => order.push(2));
    f.signal();
    readback.poll();
    expect(order).toEqual([1, 2]);
    readback.request(fbo, 10, rect, () => order.push(3));
    expect(f.raw.createBuffer).toHaveBeenCalledTimes(2);
  });

  it('drops the oldest reads beyond the cap', () => {
    const f = fakeGl();
    const readback = new Readback(f.gl);
    const done = vi.fn();
    for (let i = 0; i < MAX_PENDING_READS + 2; i++) readback.request(fbo, 10, rect, done);
    expect(readback.size).toBe(MAX_PENDING_READS);
    f.signal();
    readback.poll();
    expect(done).toHaveBeenCalledTimes(MAX_PENDING_READS);
  });

  it('after a lost context, forgets reads without touching dead handles', () => {
    const f = fakeGl();
    const readback = new Readback(f.gl);
    const done = vi.fn();
    readback.request(fbo, 10, rect, done);
    readback.reset(true);
    expect(f.raw.deleteSync).not.toHaveBeenCalled();
    expect(f.raw.deleteBuffer).not.toHaveBeenCalled();
    f.signal();
    readback.poll();
    expect(done).not.toHaveBeenCalled();
  });
});

describe('Picker', () => {
  const frame = (generation: number) => ({
    fbo,
    attachment: 10,
    cols: 10,
    rows: 10,
    dpr: 1,
    grid: { shiftX: 0, shiftY: 0, cellWidth: 10, cellHeight: 10 },
    camera: { lat: 0, lng: 0, zoom: 14 },
    size: { width: 100, height: 100 },
    generation,
  });

  it('retains a click while speech and four frames of hover reads await the GPU', () => {
    const f = fakeGl();
    const readback = new Readback(f.gl);
    const result = vi.fn<(pick: PickResult) => void>();
    const picker = new Picker(readback, () => 1, result);
    const speech = new SpeechController(
      readback,
      10,
      () => {},
      () => 0,
    );
    const owners = new Uint32Array(100);
    owners[22] = 1;
    const life = new Uint8Array(400);
    life[22 * 4 + 1] = classId('life_person');
    life[22 * 4 + 2] = CellBit.person;
    const speechFrame: SpeechFrame = {
      targets: { cols: 10, rows: 10, glyphFbo: fbo, sub: { fbo } as SpeechFrame['targets']['sub'] },
      grid: frame(1).grid,
      dpr: 1,
      geometry: 'same',
      owners,
      life,
      agents: [
        {
          kind: 'person',
          lng: 2.5,
          lat: 2.5,
          flap: 0,
          speech: { id: 'one', exchangeId: 'hello', line: 0 },
        },
      ],
      toCell: (lng, lat) => [lng, lat],
      size: { width: 100, height: 100 },
      labelsCover: () => false,
    };
    picker.click([25, 25]);
    picker.issue(frame(1));
    speech.update(speechFrame, 0);
    expect(readback.size).toBe(4);
    for (let i = 1; i <= 4; i++) {
      picker.hover([35, 35]);
      picker.issue(frame(1));
      speech.update(speechFrame, i * 33);
      expect(readback.size).toBeLessThanOrEqual(MAX_PENDING_READS);
    }
    expect(f.deleted).toHaveLength(0);
    f.signal();
    readback.poll();
    expect(result.mock.calls.filter(([pick]) => pick.click)).toHaveLength(1);
    expect(readback.size).toBe(0);
  });

  it('answers with the feature index under the point, a frame later', () => {
    const f = fakeGl();
    const readback = new Readback(f.gl);
    const onResult = vi.fn();
    const picker = new Picker(readback, () => 1, onResult);
    f.setValue([5, 1, 0, 0]);
    picker.hover([25, 35]);
    picker.issue(frame(1));
    expect(f.raw.readPixels).toHaveBeenCalledWith(2, 3, 1, 1, 3, 4, 0);
    expect(onResult).not.toHaveBeenCalled();
    f.signal();
    readback.poll();
    expect(onResult).toHaveBeenCalledWith(
      expect.objectContaining({ point: [25, 35], click: false, index: 261 }),
    );
  });

  it('lets a click win over a hover in the same frame', () => {
    const f = fakeGl();
    const readback = new Readback(f.gl);
    const onResult = vi.fn();
    const picker = new Picker(readback, () => 1, onResult);
    picker.click([10, 10]);
    picker.hover([50, 50]);
    picker.issue(frame(1));
    f.signal();
    readback.poll();
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult.mock.calls[0]![0]).toMatchObject({ point: [10, 10], click: true });
  });

  it('drops a read from render targets that have since been recreated', () => {
    const f = fakeGl();
    const readback = new Readback(f.gl);
    const onResult = vi.fn();
    let generation = 1;
    const picker = new Picker(readback, () => generation, onResult);
    picker.hover([10, 10]);
    picker.issue(frame(1));
    generation = 2;
    f.signal();
    readback.poll();
    expect(onResult).not.toHaveBeenCalled();
  });

  it('answers a point off the grid at once, with no feature', () => {
    const f = fakeGl();
    const onResult = vi.fn();
    const picker = new Picker(new Readback(f.gl), () => 1, onResult);
    picker.click([500, 500]);
    picker.issue(frame(1));
    expect(f.raw.readPixels).not.toHaveBeenCalled();
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ index: 0, click: true }));
  });
});
