import type { Atlas } from '@atlas/renderer';

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
export const prefersReducedMotion = () => window.matchMedia(REDUCED_MOTION).matches;
export const subscribeReducedMotion = (onChange: () => void) => {
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
};

/**
 * Keep a live atlas in sync without changing the viewer's saved Life settings. The atlas starts
 * with the preference (`AtlasOptions.reducedMotion`); this follows its changes.
 */
export const listenReducedMotion = (atlas: Pick<Atlas, 'setReducedMotion'>) =>
  subscribeReducedMotion(() => atlas.setReducedMotion(prefersReducedMotion()));
