// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACTIVE_FRAME_MS,
  ACTIVE_MS,
  animationDue,
  cameraDue,
  frameInterval,
  IDLE_FRAME_MS,
  nextAnchor,
  PACING_SLACK_MS,
  watchVisibility,
} from './pacing';

describe('animationDue', () => {
  const watching = { reducedMotion: false, watched: true };

  it('draws at the interactive cap just after input, then at the idle rate', () => {
    expect(animationDue(1000, 1000 - ACTIVE_FRAME_MS, 900, watching)).toBe(true);
    expect(animationDue(1000, 1000 - ACTIVE_FRAME_MS + PACING_SLACK_MS + 1, 900, watching)).toBe(
      false,
    );
    const idle = 1000 + ACTIVE_MS;
    expect(animationDue(idle, idle - 1, 1000, watching)).toBe(false);
    expect(animationDue(idle, idle - ACTIVE_FRAME_MS, 1000, watching)).toBe(false);
    expect(animationDue(idle, idle - IDLE_FRAME_MS + 1, 1000, watching)).toBe(true);
    expect(animationDue(1000, -Infinity, -Infinity, watching)).toBe(true);
  });

  /**
   * Drawn frames per second over two seconds of rAF ticks at `hz`, with ±0.8 ms of timestamp
   * jitter, and the longest gap between draws in ticks.
   */
  const pace = (hz: number, input: boolean, due: (now: number, anchor: number) => boolean) => {
    let anchor = -Infinity;
    let drawn = 0;
    let last = -1;
    let gap = 0;
    for (let tick = 0; tick < hz * 3; tick++) {
      const now = 10_000 + (tick * 1000) / hz + (tick % 3 === 0 ? 0.8 : tick % 3 === 1 ? -0.8 : 0);
      if (!due(now, anchor)) continue;
      anchor = nextAnchor(now, anchor, frameInterval(now, input ? now : -Infinity));
      if (tick >= hz) {
        drawn++;
        if (last >= hz) gap = Math.max(gap, tick - last);
      }
      last = tick;
    }
    return { fps: drawn / 2, gap };
  };

  it.each([
    [60, 30, 60, 1],
    [90, 30, 60, 2],
    [100, 33.3, 66.7, 2],
    [120, 30, 60, 2],
    [144, 31, 72, 2],
    [165, 33, 68.5, 3],
  ])('paces a %d Hz display to %d fps idle and %d fps under input', (hz, idle, active, maxGap) => {
    const quiet = pace(hz, false, (now, anchor) => animationDue(now, anchor, -Infinity, watching));
    expect(Math.abs(quiet.fps - idle)).toBeLessThanOrEqual(1);
    const busy = pace(hz, true, (now, anchor) => animationDue(now, anchor, now, watching));
    expect(Math.abs(busy.fps - active)).toBeLessThanOrEqual(1);
    // Never every tick above 60 Hz, and never more than the cap's own spacing apart.
    expect(busy.gap).toBeLessThanOrEqual(maxGap);
    const camera = pace(hz, true, (now, anchor) => cameraDue(now, anchor, watching));
    expect(camera.fps).toBe(busy.fps);
  });

  it('keeps the phase after a late frame and restarts it after an early or very late one', () => {
    expect(nextAnchor(1022, 1000, ACTIVE_FRAME_MS)).toBe(1000 + ACTIVE_FRAME_MS);
    expect(nextAnchor(1014, 1000, ACTIVE_FRAME_MS)).toBe(1014);
    expect(nextAnchor(1100, 1000, ACTIVE_FRAME_MS)).toBe(1100);
    expect(nextAnchor(500, -Infinity, IDLE_FRAME_MS)).toBe(500);
  });

  it('keeps camera redraws immediate with reduced motion or while unwatched', () => {
    expect(cameraDue(1000, 999, watching)).toBe(false);
    expect(cameraDue(1000, 999, { reducedMotion: true, watched: true })).toBe(true);
    expect(cameraDue(1000, 999, { reducedMotion: false, watched: false })).toBe(true);
    expect(cameraDue(1000, -Infinity, watching)).toBe(true);
  });

  it('never moves on its own with reduced motion, or while no one can watch', () => {
    expect(animationDue(1000, 0, 999, { reducedMotion: true, watched: true })).toBe(false);
    expect(animationDue(1000, 0, 999, { reducedMotion: false, watched: false })).toBe(false);
  });
});

describe('watchVisibility', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is unwatched while the window is unfocused or the tab hidden', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const canvas = document.createElement('canvas');
    const changes: boolean[] = [];
    const watch = watchVisibility(canvas, (w) => changes.push(w));
    expect(watch.watched()).toBe(true);

    window.dispatchEvent(new Event('blur'));
    expect(watch.watched()).toBe(false);
    window.dispatchEvent(new Event('focus'));
    expect(watch.watched()).toBe(true);

    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(watch.watched()).toBe(false);
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(changes).toEqual([false, true, false, true]);

    watch.detach();
    window.dispatchEvent(new Event('blur'));
    expect(changes).toHaveLength(4);
  });

  it('starts unwatched in a window without focus', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const watch = watchVisibility(document.createElement('canvas'), () => {});
    expect(watch.watched()).toBe(false);
    watch.detach();
  });
});
