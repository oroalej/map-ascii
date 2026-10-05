'use client';

import { eventOccurrence, type RuntimeSeasonConfig } from '@atlas/shared';
import { useSyncExternalStore } from 'react';
import { useAtlasInstance } from '@/state/store';
import { useLifeStore } from '@/state/life';
import { useUiStore } from '@/state/ui';
import { useProcessionPlayback } from './useProcessionPlayback';
import styles from './Hud.module.css';

export function useSeasonState() {
  const atlas = useAtlasInstance((s) => s.atlas);
  return useSyncExternalStore(
    (change) => atlas?.on('seasonchange', change) ?? (() => {}),
    () => atlas?.getSeason() ?? null,
    () => null,
  );
}

export function useShownSeason(seasons?: readonly RuntimeSeasonConfig[]) {
  const choice = useLifeStore((s) => s.season ?? 'auto');
  const active = useSeasonState();
  const selected = seasons?.find((s) => s.id === choice);
  const shown =
    selected ?? (choice === 'auto' ? seasons?.find((s) => s.id === active?.id) : undefined);
  return { choice, selected, shown };
}

/** Preview changes the decorative calendar only; time, timeline and URL remain independent. */
export function SeasonControl({
  seasons,
}: {
  seasons?: readonly RuntimeSeasonConfig[] | undefined;
}) {
  const { choice, selected, shown } = useShownSeason(seasons);
  if (!seasons?.length) return null;
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

/** A separate row below the controls, linked to the shown season through pack metadata. */
export function SeasonEvents({
  seasons,
}: {
  seasons?: readonly RuntimeSeasonConfig[] | undefined;
}) {
  const { shown } = useShownSeason(seasons);
  const processions = useUiStore((s) => s.processions);
  const { available, play } = useProcessionPlayback();
  if (!shown) return null;
  const now = new Date();
  const events = processions
    .filter((p) => p.season === shown.id)
    .sort(
      (a, b) =>
        eventOccurrence(a.schedule, now).startMs - eventOccurrence(b.schedule, now).startMs ||
        a.id.localeCompare(b.id),
    );
  if (!events.length) return null;
  return (
    <div className={styles.row}>
      {events.map((p) => (
        <button
          key={p.id}
          type="button"
          className={styles.button}
          disabled={!available}
          title={available ? 'Play it as a time-lapse' : 'Turn Life on to see it'}
          onClick={() => play(p.id)}
        >
          ▶ {p.label!.en}
        </button>
      ))}
    </div>
  );
}
