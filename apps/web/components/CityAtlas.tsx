'use client';

import type { Landmark, LandmarkArt } from '@atlas/shared';
import { useEffect } from 'react';
import { useAtlasStore } from '@/state/store';
import { useAtlasEvents } from '@/state/useAtlasEvents';
import { useUrlSync } from '@/state/useUrlSync';
import { AtlasCanvas } from './AtlasCanvas';
import { Attribution } from './Attribution';
import { HoverTooltip } from './HoverTooltip';
import { Hud } from './Hud';
import { InfoPanel } from './InfoPanel';
import { SearchBox } from './SearchBox';

export type CityAtlasProps = {
  slug: string;
  name: string;
  /** The city's local word for a subdivision, e.g. "barangay". */
  subdivisionLabel: string;
  landmarks: readonly Landmark[];
  art: readonly LandmarkArt[];
};

/** One city's atlas: the map and everything around it, with the view mirrored in the URL. */
export function CityAtlas({ slug, name, subdivisionLabel, landmarks, art }: CityAtlasProps) {
  useEffect(() => {
    useAtlasStore.getState().setCity(slug);
  }, [slug]);
  useUrlSync();
  useAtlasEvents();

  return (
    <>
      <AtlasCanvas slug={slug} name={name} subdivisionLabel={subdivisionLabel} />
      <Hud city={slug} subdivisionLabel={subdivisionLabel} />
      <SearchBox city={slug} subdivisionLabel={subdivisionLabel} />
      <HoverTooltip />
      <InfoPanel city={slug} subdivisionLabel={subdivisionLabel} landmarks={landmarks} art={art} />
      <Attribution />
    </>
  );
}
