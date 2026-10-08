import { artChars, type ArtRole, type LandmarkArt } from '@atlas/shared';
import type { ReactNode } from 'react';
import styles from './ArtView.module.css';

/** Widest drawing the panel shows, in characters. */
const MAX_WIDTH = 36;
type Drawing = Pick<LandmarkArt, 'title' | 'palette' | 'variants'>;

/** The largest variant that fits (variants are smallest first). */
function pickVariant(art: Drawing) {
  const fits = art.variants.filter((v) => artChars(v.rows[0] ?? '').length <= MAX_WIDTH);
  return fits.at(-1) ?? art.variants[0]!;
}

/**
 * A landmark's front-view drawing (the city pack's `art/`), colored by its palette roles. It
 * belongs in the facts dialog's Drawing disclosure; the map is strictly top-down (SPEC.md §4).
 */
export function ArtView({ art }: { art: Drawing }) {
  const variant = pickVariant(art);
  const firstRole = Object.values(art.palette)[0];
  const roleOf = (key: string): ArtRole | undefined =>
    art.palette[key] ?? (key === ' ' ? firstRole : undefined);

  const rows = variant.rows.map((row, r) => {
    const chars = artChars(row);
    const keys = artChars(variant.colors[r] ?? '');
    // Runs of one role become one span.
    const runs: ReactNode[] = [];
    let start = 0;
    for (let i = 1; i <= chars.length; i++) {
      if (i < chars.length && roleOf(keys[i] ?? ' ') === roleOf(keys[start] ?? ' ')) continue;
      const role = roleOf(keys[start] ?? ' ');
      runs.push(
        <span key={start} className={role ? styles[role] : undefined}>
          {chars.slice(start, i).join('')}
        </span>,
      );
      start = i;
    }
    return (
      <span key={r} className={styles.row}>
        {runs}
      </span>
    );
  });

  return (
    <figure className={styles.figure}>
      <pre className={styles.art} aria-hidden="true">
        {rows}
      </pre>
      <figcaption className={styles.caption}>{art.title}</figcaption>
    </figure>
  );
}
