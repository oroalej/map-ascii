import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACTIVE_MS, animationDue, IDLE_FRAME_MS, watchVisibility } from './pacing';

describe('animationDue', () => {
  const watching = { reducedMotion: false, watched: true };

  it('draws every frame just after input, then at the idle rate', () => {
    expect(animationDue(1000, 999, 900, watching)).toBe(true);
    const idle = 1000 + ACTIVE_MS;
    expect(animationDue(idle, idle - 1, 1000, watching)).toBe(false);
    expect(animationDue(idle, idle - IDLE_FRAME_MS - 1, 1000, watching)).toBe(true);
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
