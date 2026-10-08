import { useCallback, useEffect, useState, useRef } from 'react';
import type { Landmark } from '@atlas/shared';
import { loadLandmarks } from '@/lib/content';
import { afterFirstTileFrame } from '@/lib/startup';
import { useAtlasStore } from './store';

const EMPTY: readonly Landmark[] = [];
export function useLandmarks(city: string) {
  const [loaded, setLoaded] = useState<{ city: string; data: readonly Landmark[] } | null>(null);
  const selected = useAtlasStore((s) => s.selectedId !== null);
  // A lifetime token prevents a response from setting state after replacement or unmount.
  const lifetimeRef = useRef(false);
  const request = useCallback(() => {
    void loadLandmarks(city)
      .then((data) => {
        if (lifetimeRef.current && useAtlasStore.getState().city === city)
          setLoaded({ city, data });
      })
      .catch(() => {});
  }, [city, lifetimeRef]);
  useEffect(() => {
    lifetimeRef.current = true;
    const off = afterFirstTileFrame(city, request);
    return () => {
      lifetimeRef.current = false;
      off();
    };
  }, [city, request, lifetimeRef]);
  useEffect(() => {
    if (selected) request();
  }, [selected, request]);
  return {
    landmarks: loaded?.city === city ? loaded.data : EMPTY,
    request,
    loaded: loaded?.city === city,
  };
}
