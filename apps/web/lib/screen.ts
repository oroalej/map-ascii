'use client';
import { useSyncExternalStore } from 'react';
export const SMALL_SCREEN = '(max-width: 640px)';
const subscribe = (changed: () => void) => {
  const media = window.matchMedia(SMALL_SCREEN);
  media.addEventListener('change', changed);
  return () => media.removeEventListener('change', changed);
};
export const useSmallScreen = () =>
  useSyncExternalStore(
    subscribe,
    () => window.matchMedia(SMALL_SCREEN).matches,
    () => false,
  );
