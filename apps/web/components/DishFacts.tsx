'use client';
import type { Dish } from '@atlas/shared';
import { useEffect, useId, useRef, useState } from 'react';
import { useSmallScreen } from '@/lib/screen';
import { useAtlasStore } from '@/state/store';
import { useUiStore } from '@/state/ui';
import { selectPlace } from '@/state/selection';
import { DishDetails } from './FoodDetails';
import { focusFacts, publishFactsVisible } from './facts-visibility';
import shell from './LandmarkFacts.module.css';
import styles from './LandmarkDetails.module.css';

export function DishFacts({ dishes }: { dishes: readonly Dish[] }) {
  const id = useAtlasStore((state) => state.selectedId);
  const selection = useUiStore((state) => state.selection);
  const dish = dishes.find((entry) => entry.id === id);
  const small = useSmallScreen();
  const headingId = useId();
  const root = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const sequence = selection?.id === id ? selection.sequence : 0;
  useEffect(() => {
    if (!dish || !selection || selection.id !== dish.id) return;
    publishFactsVisible(sequence, true);
    if (root.current) focusFacts(root.current, sequence);
    return () => publishFactsVisible(sequence, false);
  }, [dish, selection, sequence, small]);
  if (!dish || !selection || selection.id !== dish.id) return null;
  return (
    <div
      ref={root}
      className={small ? shell.sheet : shell.dish}
      data-expanded={expanded}
      role="dialog"
      aria-modal="false"
      aria-labelledby={headingId}
      data-speech-obstacle
    >
      {small && (
        <button
          type="button"
          className={shell.handle}
          aria-label={expanded ? 'Collapse facts' : 'Expand facts'}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        />
      )}
      <header className={styles.header}>
        <p className={styles.type}>Dish</p>
        <button
          type="button"
          className={styles.close}
          aria-label="Close"
          onClick={() => selectPlace(null)}
        >
          ×
        </button>
      </header>
      <h2 id={headingId} tabIndex={-1} className={styles.name}>
        {dish.name.en}
      </h2>
      <DishDetails dish={dish} prefix={`${headingId}-${dish.id.replace('/', '-')}`} />
    </div>
  );
}
