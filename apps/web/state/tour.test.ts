import type { Tour } from '@atlas/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initialAtlasState, useAtlasStore } from './store';
import { setTourRunner, tourControls, useTourStore, type TourRunner } from './tour';

const camera = { lat: 1, lng: 2, zoom: 15 };
const tour: Tour = {
  id: 'tour/example',
  title: { en: 'Example' },
  status: 'draft',
  steps: [
    { camera, duration_ms: 4000, narration: { en: 'One' }, select: 'osm:way/1' },
    { camera: { ...camera, zoom: 16 }, duration_ms: 5000, narration: { en: 'Two' } },
  ],
};

describe('tourControls', () => {
  let runner: { [K in keyof TourRunner]: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    useAtlasStore.setState(initialAtlasState());
    useTourStore.setState({ tours: [tour], active: null, menuOpen: true });
    runner = { show: vi.fn(), hold: vi.fn(), cancelHold: vi.fn(), stop: vi.fn() };
    setTourRunner(runner as unknown as TourRunner);
  });

  it('starts a tour by slug, shows its first step, and mirrors it in the atlas store', () => {
    expect(tourControls.start('example')).toBe(true);
    expect(runner.show).toHaveBeenCalledWith(tour.steps[0]);
    expect(useAtlasStore.getState().tour).toEqual({ id: 'example', step: 0, paused: false });
    expect(useTourStore.getState().menuOpen).toBe(false);
  });

  it('holds after the flight and moves to the next step when the dwell ends', () => {
    tourControls.start('example');
    tourControls.flyEnd();
    expect(runner.hold).toHaveBeenCalledWith(4000);
    tourControls.dwellDone();
    expect(runner.show).toHaveBeenLastCalledWith(tour.steps[1]);
    expect(useAtlasStore.getState().tour?.step).toBe(1);
  });

  it('pauses on a grab and marks the URL state paused', () => {
    tourControls.start('example');
    tourControls.grab();
    expect(useAtlasStore.getState().tour?.paused).toBe(true);
    expect(useTourStore.getState().active?.run.grabbed).toBe(true);
  });

  it('restores from a URL without moving the camera', () => {
    expect(tourControls.restore('example', 1)).toBe(true);
    expect(runner.show).not.toHaveBeenCalled();
    expect(useAtlasStore.getState().tour).toEqual({ id: 'example', step: 1, paused: true });
    expect(tourControls.restore('nope', 0)).toBe(false);
  });

  it('exits: stops the flight and clears the tour', () => {
    tourControls.start('example');
    tourControls.exit();
    expect(runner.stop).toHaveBeenCalled();
    expect(useTourStore.getState().active).toBeNull();
    expect(useAtlasStore.getState().tour).toBeNull();
  });

  it('needs the atlas to start', () => {
    setTourRunner(null);
    expect(tourControls.start('example')).toBe(false);
  });
});
