'use client';
import { useAtlasInstance } from '@/state/store';
import { tourControls, tourSlug, useTourStore } from '@/state/tour';
import styles from './TourMenu.module.css';
export function TourList({ id }: { id: string }) {
  const status = useTourStore((s) => s.dataStatus);
  const tours = useTourStore((s) => s.tours);
  const ready = useAtlasInstance((s) => s.atlas !== null);
  return (
    <ul id={id} className={styles.list} aria-label="Tours">
      {status === 'error' && (
        <li>
          <button type="button" onClick={() => void tourControls.load()}>
            Retry loading tours
          </button>
        </li>
      )}
      {(status === 'loading' || status === 'unloaded') && <li role="status">Loading tours…</li>}
      {status === 'ready' && !tours.length && <li>No tours available.</li>}
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
                <span className={styles.badge} title="Narration not yet checked against sources">
                  draft
                </span>
              )}
            </span>
            {tour.description && <span className={styles.description}>{tour.description.en}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}
