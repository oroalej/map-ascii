'use client';
import type { Tour } from '@atlas/shared';
import { useAtlasInstance } from '@/state/store';
import { tourControls, tourSlug, useTourStore } from '@/state/tour';
import type { TourGroup } from './TourMenu';
import styles from './TourMenu.module.css';
export function TourList({
  id,
  tourGroups,
}: {
  id: string;
  tourGroups?: readonly TourGroup[] | undefined;
}) {
  const status = useTourStore((s) => s.dataStatus);
  const tours = useTourStore((s) => s.tours);
  const ready = useAtlasInstance((s) => s.atlas !== null);
  const renderTour = (tour: Tour) => (
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
  );
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
      {tourGroups
        ? tourGroups.map((group) => {
            const grouped = tours.filter((tour) => tour.group === group.id);
            if (!grouped.length) return null;
            const headingId = `${id}-${group.id}`;
            return (
              <li key={group.id}>
                <h3 id={headingId} className={styles.groupHeading}>
                  {group.label}
                </h3>
                <ul className={styles.groupList} aria-labelledby={headingId}>
                  {grouped.map(renderTour)}
                </ul>
              </li>
            );
          })
        : tours.map(renderTour)}
    </ul>
  );
}
