'use client';

import { useEffect } from 'react';
import { useAtlasInstance, useAtlasStore } from './store';
import { isPickable, useUiStore } from './ui';
import { selectPlace } from './selection';
import { tourControls } from './tour';

/** Search and Places in view approach a landmark at least this close. */
export const PLACE_ZOOM = 17.5;

/**
 * Connect the renderer to the app (ARCHITECTURE.md §2: the app owns state, the renderer emits
 * events):
 * - landmarks with facts respond to hover and click; clicks keep the current camera;
 * - the selection in the store (from clicks, search, or the URL) drives the renderer's;
 * - Esc cancels a flight and closes the facts dialog.
 */
export function useAtlasEvents() {
  const atlas = useAtlasInstance((s) => s.atlas);

  useEffect(() => {
    useUiStore.setState({ lifeHover: null, hover: null });
    if (!atlas) return;
    atlas.setSelected(useAtlasStore.getState().selectedId);
    const offHover = atlas.on('hover', ({ feature, point }) => {
      const hover =
        isPickable(feature, useUiStore.getState().clickable) && point ? { feature, point } : null;
      useUiStore.setState({ hover });
      useAtlasStore.getState().setHover(hover?.feature.id ?? null);
    });
    const offClick = atlas.on('click', ({ feature, lngLat }) => {
      if (!isPickable(feature, useUiStore.getState().clickable)) {
        selectPlace(null);
        return;
      }
      tourControls.grab();
      atlas.setCamera(atlas.getCamera());
      selectPlace(feature.id, { origin: 'pointer', anchor: lngLat, picked: feature });
    });
    const offLifeHover = atlas.on('lifehover', (hover) => {
      useUiStore.setState({ lifeHover: hover.label === null ? null : hover });
    });
    const offSelection = useAtlasStore.subscribe((s, prev) => {
      if (s.selectedId === prev.selectedId) return;
      atlas.setSelected(s.selectedId);
      atlas.setHighlighted([]);
      if (s.selectedId !== useUiStore.getState().picked?.id) useUiStore.setState({ picked: null });
    });
    return () => {
      offHover();
      offLifeHover();
      offClick();
      offSelection();
    };
  }, [atlas]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const current = useAtlasInstance.getState().atlas;
      // A non-animated camera update ends any flight where it is.
      if (current) current.setCamera(current.getCamera());
      selectPlace(null);
      useUiStore.setState({ legendFocus: null });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
