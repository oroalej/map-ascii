import { CameraState } from '@atlas/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { initialAtlasState, useAtlasStore } from './store';

describe('useAtlasStore', () => {
  beforeEach(() => useAtlasStore.setState(initialAtlasState()));

  it('starts on a valid camera over Naga in the current year', () => {
    const { camera, year, mode, theme } = useAtlasStore.getState();
    expect(CameraState.safeParse(camera).success).toBe(true);
    expect(year).toBe(new Date().getFullYear());
    expect(mode).toBe('map');
    expect(theme).toBe('dark');
  });

  it('merges partial camera updates', () => {
    useAtlasStore.getState().setCamera({ zoom: 16 });
    expect(useAtlasStore.getState().camera).toMatchObject({ lat: 13.6218, zoom: 16 });
  });
});
