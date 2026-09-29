'use client';

import { useEffect } from 'react';
import { useAtlasInstance, useAtlasStore } from './store';
import { isPickable, useUiStore } from './ui';

/** Clicking a place flies at least this close (SPEC.md §2: the Place level). */
export const PLACE_ZOOM = 17.5;

/**
 * Connect the renderer to the app (ARCHITECTURE.md §2: the app owns state, the renderer emits
 * events):
 * - hovering a landmark shows the tooltip; a click on a landmark selects it and flies there, a
 *   click on anything else clears the selection (only landmarks respond, `isPickable`);
 * - the selection in the store (from clicks, search, or the URL) drives the renderer's;
 * - Esc cancels a flight and closes the panel.
 */
export function useAtlasEvents() {
  const atlas = useAtlasInstance((s) => s.atlas);

  useEffect(() => {
    if (!atlas) return;
    atlas.setSelected(useAtlasStore.getState().selectedId);
    const offHover = atlas.on('hover', ({ feature, point }) => {
      const hover = isPickable(feature) && point ? { feature, point } : null;
      useUiStore.setState({ hover });
      useAtlasStore.getState().setHover(hover?.feature.id ?? null);
    });
    const offClick = atlas.on('click', ({ feature, lngLat }) => {
      const store = useAtlasStore.getState();
      if (!isPickable(feature)) {
        store.setSelected(null);
        return;
      }
      useUiStore.setState({ picked: feature });
      store.setSelected(feature.id);
      const [lng, lat] = lngLat;
      atlas.flyTo({ lng, lat, zoom: Math.max(atlas.getCamera().zoom, PLACE_ZOOM) });
    });
    const offSelection = useAtlasStore.subscribe((s, prev) => {
      if (s.selectedId === prev.selectedId) return;
      atlas.setSelected(s.selectedId);
      atlas.setHighlighted([]);
      if (s.selectedId !== useUiStore.getState().picked?.id) useUiStore.setState({ picked: null });
    });
    return () => {
      offHover();
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
      useAtlasStore.getState().setSelected(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
