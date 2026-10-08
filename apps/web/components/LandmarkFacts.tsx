'use client';
import type { Dish, Landmark, CityArt } from '@atlas/shared';
import { useId, useMemo, useEffect, useState } from 'react';
import { loadArt } from '@/lib/content';
import { clickableLandmark } from '@/lib/landmark';
import { useSmallScreen } from '@/lib/screen';
import { useAtlasStore } from '@/state/store';
import { useUiStore } from '@/state/ui';
import { useSelectedDetails } from '@/state/useSelectedDetails';
import { LandmarkPopover } from './LandmarkPopover';
import { LandmarkSheet } from './LandmarkSheet';

export function LandmarkFacts({
  city,
  subdivisionLabel,
  landmarks,
  dishes = [],
  art,
}: {
  city: string;
  subdivisionLabel: string;
  landmarks: readonly Landmark[];
  dishes?: readonly Dish[];
  art?: readonly CityArt['pieces'][number][];
}) {
  const [drawings, setDrawings] = useState<{ city: string; pieces: CityArt['pieces'] } | null>(
    null,
  );
  useEffect(() => {
    if (art) return;
    let cancelled = false;
    void loadArt(city)
      .then((pieces) => {
        if (!cancelled) setDrawings({ city, pieces });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [city, art]);
  const pieces = art ?? (drawings?.city === city ? drawings.pieces : []);
  const id = useAtlasStore((s) => s.selectedId),
    touring = useAtlasStore((s) => s.tour !== null);
  const selection = useUiStore((s) => s.selection),
    clicked = useUiStore((s) => s.anchor);
  const landmark = clickableLandmark(id, landmarks),
    small = useSmallScreen();
  const details = useSelectedDetails(city, landmark ? id : null),
    headingId = useId();
  const sequence = selection?.id === id ? selection.sequence : 0;
  const entry = details.entry;
  const anchor = useMemo(
    () =>
      clicked?.id === id && clicked.sequence === sequence
        ? clicked.lngLat
        : entry
          ? ([entry.lng, entry.lat] as const)
          : null,
    [clicked, id, sequence, entry],
  );
  if (
    !landmark ||
    !selection ||
    selection.id !== id ||
    (small && touring && selection.origin === 'programmatic')
  )
    return null;
  const body = {
    landmark,
    dishes,
    drawing: pieces.find((a) => a.osm_id === id),
    subdivisionLabel,
    details,
    headingId,
    sequence,
  };
  return small ? (
    <LandmarkSheet key={sequence} {...body} />
  ) : (
    <LandmarkPopover key={sequence} {...body} anchor={anchor} />
  );
}
