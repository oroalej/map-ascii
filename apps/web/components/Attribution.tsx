'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useUiStore } from '@/state/ui';
import { additionalCredits, creditTokens } from '@/lib/attribution';
import styles from './Attribution.module.css';

/** One empty list, so the store selector returns a stable value before the meta loads. */
const NONE: readonly string[] = [];

/** The footer's height, for the panels that sit above it (the tour card, the HUD). */
const HEIGHT_VAR = '--attribution-height';

/**
 * Permanent OpenStreetMap attribution, with other map credits one click away (DATA.md §6).
 */
export function Attribution() {
  const credits = useUiStore((s) => s.meta?.attribution ?? NONE);
  const extra = additionalCredits(credits);
  const ref = useRef<HTMLElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const sourcesId = useId();
  const [open, setOpen] = useState(false);
  const expanded = open && extra.length > 0;

  useEffect(() => {
    if (!expanded) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [expanded]);

  // Only the footer row reserves space; the Sources panel overlays the map.
  useLayoutEffect(() => {
    const footer = rowRef.current;
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
    <footer ref={ref} className={styles.attribution} data-open={expanded} data-speech-obstacle>
      <div ref={rowRef}>
        ©{' '}
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
          OpenStreetMap contributors
        </a>
        {extra.length > 0 && (
          <>
            {' · '}
            <button
              ref={buttonRef}
              type="button"
              className={styles.toggle}
              aria-expanded={expanded}
              aria-controls={sourcesId}
              onClick={() => setOpen(!expanded)}
            >
              Sources
            </button>
          </>
        )}
      </div>
      {expanded && (
        <div
          id={sourcesId}
          className={styles.sources}
          role="region"
          aria-label="Additional map sources"
          tabIndex={0}
        >
          {extra.map((credit) => (
            <span key={credit} className={styles.extra}>
              {creditTokens(credit).map((token, index) =>
                token.url ? (
                  <a key={index} href={token.url} target="_blank" rel="noreferrer">
                    {token.text}
                  </a>
                ) : (
                  token.text
                ),
              )}
            </span>
          ))}
        </div>
      )}
    </footer>
  );
}
