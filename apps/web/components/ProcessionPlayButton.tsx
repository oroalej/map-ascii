'use client';

import { useProcessionPlayback } from './useProcessionPlayback';
import styles from './Hud.module.css';

/** Shared availability, tooltip and playback behavior for both event menus. */
export function ProcessionPlayButton({ id, label }: { id: string; label: string }) {
  const { available, play } = useProcessionPlayback();
  return (
    <button
      type="button"
      className={styles.button}
      disabled={!available}
      title={available ? 'Play it as a time-lapse' : 'Turn Life on to see it'}
      onClick={() => play(id)}
    >
      ▶ {label}
    </button>
  );
}
