'use client';

import type { Atlas, LabelInView } from '@atlas/renderer';
import { useEffect, useId, useState } from 'react';
import { useAtlasInstance } from '@/state/store';
import { PLACE_ZOOM } from '@/state/useAtlasEvents';
import type { SelectionOrigin } from '@/state/ui';
import { selectPlace } from '@/state/selection';
import styles from './PlacesInView.module.css';

/** Select and fly to any named feature; landmarks with facts also open their dialog. */
function goToLabel(atlas: Atlas, label: LabelInView, origin: SelectionOrigin) {
  selectPlace(label.featureId, { origin });
  const [lng, lat] = label.lngLat;
  const zoom = atlas.getCamera().zoom;
  // Places are areas: center on them at this zoom. Landmarks and monuments: come close.
  atlas.flyTo({ lng, lat, zoom: label.kind === 'place' ? zoom : Math.max(zoom, PLACE_ZOOM) });
}

/**
 * A text alternative to the map (SPEC.md §5): the places, landmarks, and monuments whose names
 * are on screen, as a list of buttons that select and fly. It stays out of sight
 * until keyboard focus reaches it, first in the tab order.
 */
export function PlacesInView() {
  const atlas = useAtlasInstance((s) => s.atlas);
  const [inView, setInView] = useState<{ atlas: Atlas; labels: LabelInView[] } | null>(null);
  const [open, setOpen] = useState(false);
  const listId = useId();

  useEffect(() => atlas?.on('labelschange', (labels) => setInView({ atlas, labels })), [atlas]);
  const labels = inView && inView.atlas === atlas ? inView.labels : [];

  return (
    <nav className={styles.places} aria-label="Places in view">
      <button
        type="button"
        className={styles.toggle}
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen(!open)}
      >
        Places in view ({labels.length})
      </button>
      {open && (
        <ul id={listId} className={styles.list}>
          {labels.length === 0 && <li className={styles.empty}>No named places on screen.</li>}
          {labels.map((label) => {
            // Names repeat across subdivisions (e.g. "Zone 2"); say which one.
            const subdivision = atlas?.getFeature(label.featureId)?.subdivision;
            return (
              <li key={label.featureId}>
                <button
                  type="button"
                  className={styles.item}
                  onClick={(event) =>
                    atlas && goToLabel(atlas, label, event.detail === 0 ? 'keyboard' : 'pointer')
                  }
                >
                  {label.name}{' '}
                  <span className={styles.kind}>
                    · {label.kind}
                    {subdivision && subdivision !== label.name ? `, ${subdivision}` : ''}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </nav>
  );
}
