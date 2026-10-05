'use client';

import type { RuntimeSeasonConfig } from '@atlas/shared';
import { useSyncExternalStore } from 'react';
import { useAtlasInstance } from '@/state/store';
import { useLifeStore } from '@/state/life';
import styles from './Hud.module.css';

export function useSeasonState() {
  const atlas = useAtlasInstance((s) => s.atlas);
  return useSyncExternalStore(
    (change) => atlas?.on('seasonchange', change) ?? (() => {}),
    () => atlas?.getSeason() ?? null,
    () => null,
  );
}

/** Preview changes the decorative calendar only; time, timeline and URL remain independent. */
export function SeasonControl({
  seasons,
}: {
  seasons?: readonly RuntimeSeasonConfig[] | undefined;
}) {
  const choice = useLifeStore((s) => s.season ?? 'auto');
  const active = useSeasonState();
  if (!seasons?.length) return null;
  const selected = seasons.find((s) => s.id === choice);
  const shown =
    selected ?? (choice === 'auto' ? seasons.find((s) => s.id === active?.id) : undefined);
  const label = selected ? selected.title.en : `Today${shown ? ` · ${shown.title.en}` : ''}`;
  const choices = ['auto', ...seasons.map((s) => s.id)];
  const next = choices[(Math.max(0, choices.indexOf(choice)) + 1) % choices.length]!;
  return (
    <div className={styles.seasonControl}>
      <button
        type="button"
        className={styles.button}
        aria-label={`Season: ${label}`}
        title="Preview seasonal decorations"
        onClick={() => useLifeStore.setState({ season: next })}
      >
        {label}
      </button>
    </div>
  );
}
