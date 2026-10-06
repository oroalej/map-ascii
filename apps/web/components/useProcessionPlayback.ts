'use client';

import { useSyncExternalStore } from 'react';
import { prefersReducedMotion, subscribeReducedMotion } from '@/lib/motion';
import { useLifeStore } from '@/state/life';
import { useAtlasInstance } from '@/state/store';
import { useUiStore } from '@/state/ui';

export function useLifeShown() {
  const enabled = useLifeStore((s) => s.enabled);
  const reduced = useSyncExternalStore(subscribeReducedMotion, prefersReducedMotion, () => false);
  return enabled && !reduced;
}

/** Start successfully before moving the camera; both menus use the generated outdoor anchor. */
export function useProcessionPlayback() {
  const atlas = useAtlasInstance((s) => s.atlas);
  const processions = useUiStore((s) => s.processions);
  const available = useLifeShown();
  return {
    available,
    play: (id: string) => {
      const event = processions.find((p) => p.id === id);
      if (!available || !atlas || !event || !atlas.playProcession(id)) return;
      const [lng, lat] = event.kind === 'mass' ? event.site.anchor : event.route[0]!;
      atlas.flyTo({ lng, lat, zoom: Math.max(17.5, atlas.getCamera().zoom) });
    },
  };
}
