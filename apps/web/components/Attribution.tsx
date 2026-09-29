'use client';

import { useUiStore } from '@/state/ui';
import styles from './Attribution.module.css';

/** One empty list, so the store selector returns a stable value before the meta loads. */
const NONE: readonly string[] = [];

/**
 * Always-visible source attribution (DATA.md §6): OpenStreetMap, plus the credits the city's
 * other layers need (e.g. the DEM behind the terrain), from its meta.
 */
export function Attribution() {
  const extra = useUiStore((s) => s.meta?.attribution ?? NONE);
  return (
    <footer className={styles.attribution}>
      ©{' '}
      <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
        OpenStreetMap contributors
      </a>
      {extra.map((credit) => (
        <span key={credit} className={styles.extra}>
          {' · '}
          {credit}
        </span>
      ))}
    </footer>
  );
}
