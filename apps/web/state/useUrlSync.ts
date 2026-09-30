'use client';

import { useEffect } from 'react';
import { initialAtlasState, useAtlasInstance, useAtlasStore } from './store';
import { tourControls } from './tour';
import { parseViewParams, serializeViewParams } from './url';

/** Camera changes settle this long before the URL follows (ARCHITECTURE.md §6). */
const REPLACE_DELAY_MS = 250;

/** The year a view shows when its URL has none. */
const DEFAULT_YEAR = initialAtlasState().year;

/** The URL for the current store state, or null before there is a camera. */
function currentUrl(): string | null {
  const s = useAtlasStore.getState();
  if (!s.camera) return null;
  const query = serializeViewParams({
    camera: s.camera,
    year: s.year,
    defaultYear: DEFAULT_YEAR,
    sel: s.selectedId,
    tour: s.tour,
  });
  return `${window.location.pathname}?${query}${window.location.hash}`;
}

const here = () => `${window.location.pathname}${window.location.search}${window.location.hash}`;

/**
 * Mirror the view in the URL (ARCHITECTURE.md §6):
 * - on load, the selection and year come from the URL (the camera is read when the atlas is
 *   created, since it needs the city's meta as a fallback);
 * - camera, year, and tour changes `replaceState`, debounced;
 * - a new selection or a tour start `pushState`s, so Back returns to the previous one (during a
 *   tour, its steps' selections replace instead, so a tour is one history entry);
 * - Back and Forward apply the URL to the store, the tour player, and the atlas.
 */
export function attachUrlSync() {
  const initial = parseViewParams(window.location.search);
  const store = useAtlasStore.getState();
  if (initial.sel) store.setSelected(initial.sel);
  if (initial.year !== undefined) store.setYear(initial.year);

  let timer: number | undefined;
  /** Set while applying Back/Forward, so that doesn't push a new entry. */
  let fromHistory = false;

  const unsubscribe = useAtlasStore.subscribe((s, prev) => {
    if (fromHistory) return;
    const tourStarted =
      s.tour !== null &&
      s.tour.id !== prev.tour?.id &&
      // A tour reopened from the URL is already there.
      new URLSearchParams(window.location.search).get('tour') !== s.tour.id;
    const newSelection = s.selectedId !== prev.selectedId && s.tour === null && prev.tour === null;
    if (tourStarted || newSelection) {
      window.clearTimeout(timer);
      const next = currentUrl();
      if (next && next !== here()) window.history.pushState(null, '', next);
      return;
    }
    if (
      s.camera !== prev.camera ||
      s.year !== prev.year ||
      s.tour !== prev.tour ||
      s.selectedId !== prev.selectedId
    ) {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const next = currentUrl();
        if (next && next !== here()) window.history.replaceState(null, '', next);
      }, REPLACE_DELAY_MS);
    }
  });

  const onPopState = () => {
    window.clearTimeout(timer);
    const params = parseViewParams(window.location.search);
    const year = params.year ?? DEFAULT_YEAR;
    fromHistory = true;
    try {
      const atlas = useAtlasInstance.getState().atlas;
      // Even an empty camera update stops a flight from the history entry just left.
      atlas?.setCamera(params.camera);
      atlas?.setHighlighted([]);
      if (!params.tour || !tourControls.restore(params.tour, params.step ?? 0)) {
        tourControls.exit();
      }
      const store = useAtlasStore.getState();
      store.setSelected(params.sel ?? null);
      store.setYear(year);
      atlas?.setYear(year, { animate: false });
    } finally {
      fromHistory = false;
    }
  };
  window.addEventListener('popstate', onPopState);

  return () => {
    window.clearTimeout(timer);
    unsubscribe();
    window.removeEventListener('popstate', onPopState);
  };
}

export function useUrlSync() {
  useEffect(attachUrlSync, []);
}
