'use client';

import { useEffect, useId, useRef } from 'react';
import { useAtlasInstance } from '@/state/store';
import { tourControls, tourSlug, useTourStore } from '@/state/tour';
import styles from './TourMenu.module.css';

/** The tours menu (SPEC.md §5, `T`): the city's tours, and a button to start each. */
export function TourMenu() {
  const tours = useTourStore((s) => s.tours);
  const open = useTourStore((s) => s.menuOpen);
  const ready = useAtlasInstance((s) => s.atlas !== null);
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);

  // A press anywhere else closes the menu.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) tourControls.setMenuOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  if (tours.length === 0) return null;

  return (
    <div ref={rootRef} className={styles.menu}>
      <button
        type="button"
        className={styles.toggle}
        aria-expanded={open}
        aria-controls={listId}
        aria-keyshortcuts="T"
        onClick={() => tourControls.setMenuOpen(!open)}
      >
        Tours <span className={styles.key}>T</span>
      </button>
      {open && (
        <ul id={listId} className={styles.list} aria-label="Tours">
          {tours.map((tour) => (
            <li key={tour.id}>
              <button
                type="button"
                className={styles.tour}
                disabled={!ready}
                onClick={() => tourControls.start(tourSlug(tour.id))}
              >
                <span className={styles.title}>{tour.title.en}</span>
                <span className={styles.meta}>
                  {tour.steps.length} {tour.steps.length === 1 ? 'stop' : 'stops'}
                  {tour.status === 'draft' && (
                    <span
                      className={styles.badge}
                      title="Narration not yet checked against sources"
                    >
                      draft
                    </span>
                  )}
                </span>
                {tour.description && (
                  <span className={styles.description}>{tour.description.en}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
