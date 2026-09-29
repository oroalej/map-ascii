'use client';

import { useAtlasStore } from '@/state/store';
import styles from './Compass.module.css';

/**
 * Shows which way is north and resets the view to flat and north-up (SPEC.md §3 orbit mode:
 * "A compass button resets to north-up and flat"). Right-drag or Ctrl+drag tilts and rotates.
 */
export function Compass({ onReset }: { onReset: () => void }) {
  const bearing = useAtlasStore((s) => s.camera?.bearing ?? 0);
  const pitch = useAtlasStore((s) => s.camera?.pitch ?? 0);
  const flat = Math.abs(bearing) < 0.5 && pitch < 0.5;
  return (
    <button
      type="button"
      className={styles.compass}
      data-flat={flat}
      onClick={onReset}
      aria-label={
        flat
          ? 'Compass: the map is north-up. Right-drag or Ctrl+drag to tilt and rotate.'
          : `Reset to north-up (bearing ${Math.round(bearing)}°, tilt ${Math.round(pitch)}°)`
      }
      title={flat ? 'Right-drag or Ctrl+drag to tilt and rotate' : 'Reset to north-up and flat'}
    >
      <span className={styles.needle} style={{ transform: `rotate(${-bearing}deg)` }}>
        N
        <br />▲
      </span>
    </button>
  );
}
