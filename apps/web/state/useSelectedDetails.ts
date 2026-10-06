'use client';
import type { FeatureInfo } from '@atlas/renderer';
import type { SearchEntry } from '@atlas/shared';
import { useEffect, useState } from 'react';
import { loadSearch } from '@/lib/search';
import { useAtlasInstance } from './store';
import { useUiStore } from './ui';

/** How long to wait for the selected feature's tile, when the selection came from a URL. */
const FEATURE_POLL_MS = 400;
const FEATURE_POLL_TRIES = 40;

/**
 * What is known about the selected feature, from the renderer (picked now, or once its tile
 * loads) and the search index. Either may be missing: a URL can select a feature whose tile
 * hasn't loaded yet, and most buildings aren't in the index.
 */
export function useSelectedDetails(city: string, id: string | null) {
  const picked = useUiStore((s) => s.picked);
  const atlas = useAtlasInstance((s) => s.atlas);
  // Each result is kept with the id it is for, so a stale one is never shown.
  const [loaded, setLoaded] = useState<{ id: string; info: FeatureInfo } | null>(null);
  const [found, setFound] = useState<{
    id: string;
    city: string;
    entry: SearchEntry | null;
  } | null>(null);

  useEffect(() => {
    if (!id || !atlas || picked?.id === id) return;
    let tries = 0;
    const poll = () => {
      const info = atlas.getFeature(id);
      if (info) setLoaded({ id, info });
      else if (++tries < FEATURE_POLL_TRIES) timer = window.setTimeout(poll, FEATURE_POLL_MS);
    };
    let timer = window.setTimeout(poll, 0);
    return () => window.clearTimeout(timer);
  }, [id, atlas, picked]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    loadSearch(city)
      .then((s) => {
        if (!cancelled) setFound({ id, city, entry: s.entries.get(id) ?? null });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [city, id]);

  const feature = picked?.id === id ? picked : loaded?.id === id ? loaded.info : null;
  const entry = found?.id === id && found.city === city ? found.entry : null;
  return { feature, entry };
}
