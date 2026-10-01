'use client';

import { useLayoutEffect, useRef } from 'react';
import { useUiStore } from '@/state/ui';
import styles from './Attribution.module.css';

/** One empty list, so the store selector returns a stable value before the meta loads. */
const NONE: readonly string[] = [];

/** The footer's height, for the panels that sit above it (the tour card, the HUD). */
const HEIGHT_VAR = '--attribution-height';

/**
 * Always-visible source attribution (DATA.md §6): OpenStreetMap, plus the credits the city's
 * other layers need (e.g. the DEM behind the terrain), from its meta.
 */
export function Attribution() {
  const extra = useUiStore((s) => s.meta?.attribution ?? NONE);
  const ref = useRef<HTMLElement>(null);

  // The credits wrap to more lines on narrow screens, so publish the real height rather than
  // have the panels above guess it.
  useLayoutEffect(() => {
    const footer = ref.current;
    if (!footer) return;
    const root = document.documentElement.style;
    const publish = () => root.setProperty(HEIGHT_VAR, `${footer.offsetHeight}px`);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(footer);
    return () => {
      observer.disconnect();
      root.removeProperty(HEIGHT_VAR);
    };
  }, []);

  return (
    <footer ref={ref} className={styles.attribution}>
      ©{' '}
      <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
        OpenStreetMap contributors
      </a>
      {extra.length > 0 && (
        <div
          className={styles.sources}
          role="region"
          aria-label="Additional map sources"
          tabIndex={0}
        >
          {extra.map((credit) => (
            <span key={credit} className={styles.extra}>
              {' · '}
              {credit}
            </span>
          ))}
        </div>
      )}
    </footer>
  );
}
