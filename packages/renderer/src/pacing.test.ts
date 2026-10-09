// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACTIVE_FRAME_MS,
  ACTIVE_MS,
  animationDue,
  cameraDue,
  IDLE_FRAME_MS,
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

  /** Drawn frames in one second of rAF ticks at `hz`, with ±0.8 ms of timestamp jitter. */
  const drawnPerSecond = (hz: number, due: (now: number, lastDraw: number) => boolean) => {
    let lastDraw = -Infinity;
    let drawn = 0;
    for (let tick = 0; tick < hz * 3; tick++) {
      const now = 10_000 + (tick * 1000) / hz + (tick % 3 === 0 ? 0.8 : tick % 3 === 1 ? -0.8 : 0);
      if (!due(now, lastDraw)) continue;
      lastDraw = now;
      if (tick >= hz) drawn++;
    }
    return drawn / 2;
  };

  it.each([
    [60, 30, 60],
    [120, 30, 60],
    [144, 28.8, 72],
  ])('paces a %d Hz display to %d fps idle and %d fps under input', (hz, idle, active) => {
    const idleFps = drawnPerSecond(hz, (now, last) => animationDue(now, last, -Infinity, watching));
    expect(Math.abs(idleFps - idle)).toBeLessThanOrEqual(0.5);
    expect(drawnPerSecond(hz, (now, last) => animationDue(now, last, now, watching))).toBe(active);
    expect(drawnPerSecond(hz, (now, last) => cameraDue(now, last, watching))).toBe(active);
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
