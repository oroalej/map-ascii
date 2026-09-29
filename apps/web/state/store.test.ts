import { beforeEach, describe, expect, it } from 'vitest';
import { initialAtlasState, useAtlasStore } from './store';

const camera = { lat: 1, lng: 2, zoom: 15, pitch: 0, bearing: 0 };

describe('useAtlasStore', () => {
  beforeEach(() => useAtlasStore.setState(initialAtlasState()));

  it('starts without a camera, in map mode and the current year', () => {
    const { camera, year, mode, theme } = useAtlasStore.getState();
    expect(camera).toBeNull();
    expect(year).toBe(new Date().getFullYear());
    expect(mode).toBe('map');
    expect(theme).toBe('dark');
  });

  it('ignores partial camera updates until a camera is set', () => {
    useAtlasStore.getState().setCamera({ zoom: 16 });
    expect(useAtlasStore.getState().camera).toBeNull();
  });

  it('merges partial camera updates', () => {
    useAtlasStore.getState().initCamera(camera);
    useAtlasStore.getState().setCamera({ zoom: 16 });
    expect(useAtlasStore.getState().camera).toEqual({ ...camera, zoom: 16 });
  });
});
