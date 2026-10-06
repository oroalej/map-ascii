'use client';
import { useEffect, useRef, useState } from 'react';
import { selectPlace } from '@/state/selection';
import { LandmarkDetails, type LandmarkDetailsProps } from './LandmarkDetails';
import { focusFacts, publishFactsVisible } from './facts-visibility';
import styles from './LandmarkFacts.module.css';

export function LandmarkSheet({ sequence, ...body }: LandmarkDetailsProps & { sequence: number }) {
  const [expanded, setExpanded] = useState(false);
  const swipeFrom = useRef<number | null>(null),
    root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    publishFactsVisible(sequence, true);
    if (root.current) focusFacts(root.current, sequence);
    return () => publishFactsVisible(sequence, false);
  }, [sequence]);
  return (
    <div
      ref={root}
      className={styles.sheet}
      data-expanded={expanded}
      role="dialog"
      aria-modal="false"
      aria-labelledby={body.headingId}
      data-speech-obstacle
    >
      <button
        type="button"
        className={styles.handle}
        aria-label={expanded ? 'Collapse facts' : 'Expand facts'}
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        onPointerDown={(event) => {
          swipeFrom.current = event.clientY;
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          swipeFrom.current = null;
        }}
        onPointerUp={(event) => {
          if (swipeFrom.current !== null && event.clientY - swipeFrom.current > 60)
            selectPlace(null);
          swipeFrom.current = null;
        }}
      />
      <LandmarkDetails {...body} />
    </div>
  );
}
