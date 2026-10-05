import { describe, expect, it, vi } from 'vitest';
import { CueReadback } from './cue-readback';
import { readLifeSurface } from './surface-visibility';
import type { ReadRect } from '../readback';

describe('physical cue readback lease', () => {
  it.each([0, 1, 2])(
    'retains all live siblings after synchronous rejection at slot %s',
    (rejected) => {
      const arbiter = new CueReadback(),
        release = vi.fn(arbiter.acquire('speech', 0));
      const queued: { done: (b: Uint8Array) => void; retire?: () => void }[] = [];
      let issued = 0;
      const reads = {
        size: 0,
        request: (
          _fbo: WebGLFramebuffer,
          _attachment: number,
          _rect: ReadRect,
          done: (b: Uint8Array) => void,
          retire?: () => void,
        ) => {
          const index = issued++;
          if (index === rejected) {
            retire?.();
            expect(release).not.toHaveBeenCalled();
          } else queued.push({ done, retire });
        },
      };
      const done = vi.fn();
      readLifeSurface(
        reads,
        10,
        { cols: 1, rows: 1, glyphFbo: {}, sub: { fbo: {} } as never },
        { col: 0, row: 0, sx: 0, sy: 0, cls: 0, flags: 1 },
        done,
        release,
      );
      expect(issued).toBe(3);
      expect(done).toHaveBeenCalledExactlyOnceWith(false);
      expect(arbiter.acquire('emoji', 1)).toBeUndefined();
      queued[0]!.retire?.();
      expect(arbiter.busy).toBe(true);
      queued[1]!.retire?.();
      expect(release).toHaveBeenCalledTimes(1);
      expect(arbiter.busy).toBe(false);
      const next = arbiter.acquire('emoji', 2)!;
      queued[0]!.done(new Uint8Array(4));
      queued[1]!.retire?.();
      expect(arbiter.busy).toBe(true);
      next();
      expect(arbiter.busy).toBe(false);
    },
  );
  it('releases an unused headroom-refused lease exactly once', () => {
    const arbiter = new CueReadback(),
      release = vi.fn(arbiter.acquire('speech', 0));
    const request = vi.fn();
    expect(
      readLifeSurface(
        { size: 4, request },
        10,
        { cols: 1, rows: 1, glyphFbo: {}, sub: { fbo: {} } as never },
        { col: 0, row: 0, sx: 0, sy: 0, cls: 0, flags: 1 },
        vi.fn(),
        release,
      ),
    ).toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(arbiter.busy).toBe(false);
  });
  it('defers emoji for due speech and budgets emoji plus the next speech batch', () => {
    const arbiter = new CueReadback();
    arbiter.speechWork(true, 1000);
    expect(arbiter.acquire('emoji', 0)).toBeUndefined();
    arbiter.speechWork(false, 1000);
    const release = arbiter.acquire('emoji', 0)!;
    expect(release).toBeTypeOf('function');
    release();
    arbiter.completed(800);
    expect(arbiter.acquire('emoji', 0)).toBeUndefined();
    const speech = arbiter.acquire('speech', 0)!;
    speech();
    speech();
    expect(arbiter.busy).toBe(false);
  });
});
