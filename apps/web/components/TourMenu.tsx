'use client';

import { useEffect, useId, useRef } from 'react';
import dynamic from 'next/dynamic';
import { tourControls, useTourStore } from '@/state/tour';
import styles from './TourMenu.module.css';

const TourList = dynamic(() => import('./InteractionDetails').then((m) => m.TourList), {
  ssr: false,
});

export type TourGroup = { id: string; label: string };

/** The tours menu (SPEC.md §5, `T`): the city's tours, and a button to start each. */
export function TourMenu({
  hasTours,
  tourGroups,
}: {
  hasTours: boolean;
  tourGroups?: readonly TourGroup[] | undefined;
}) {
  const open = useTourStore((s) => s.menuOpen);
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

  if (!hasTours) return null;

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
      {open && <TourList id={listId} tourGroups={tourGroups} />}
    </div>
  );
}
