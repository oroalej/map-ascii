'use client';

import { useSyncExternalStore } from 'react';
import { eventStart } from '@atlas/shared';
import { prefersReducedMotion, subscribeReducedMotion } from '@/lib/motion';
import { useLifeStore } from '@/state/life';
import { useAtlasInstance } from '@/state/store';
import { installProcessions } from '@/lib/processions';
import { useUiStore } from '@/state/ui';

export function useLifeShown() {
  const enabled = useLifeStore((s) => s.enabled);
  const reduced = useSyncExternalStore(subscribeReducedMotion, prefersReducedMotion, () => false);
  return enabled && !reduced;
}

/** Start successfully before moving the camera; both menus use the generated outdoor anchor. */
export function useProcessionPlayback() {
  const atlas = useAtlasInstance((s) => s.atlas);
  const available = useLifeShown();
  return {
    available,
    play: async (id: string) => {
      const city = useUiStore.getState().startup?.city;
      const current = () =>
        useAtlasInstance.getState().atlas === atlas &&
        useUiStore.getState().startup?.city === city &&
        useLifeStore.getState().enabled &&
        !prefersReducedMotion();
      if (!available || !atlas || !current()) return;
      let event = useUiStore.getState().processions.find((p) => p.id === id);
      if (!event) {
        if (!city) return;
        const routes = await installProcessions(city, atlas, current).catch(() => null);
        event = routes?.find((p) => p.id === id);
      }
      if (!current() || !event || !atlas.playProcession(id)) return;
      const [lng, lat] = eventStart(event);
      atlas.flyTo({ lng, lat, zoom: Math.max(17.5, atlas.getCamera().zoom) });
    },
  };
}
