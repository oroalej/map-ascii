'use client';

import type { ClimateConfig, Landmark, LandmarkArt, TrafficMix, Tour } from '@atlas/shared';
import { useEffect } from 'react';
import { useAtlasStore } from '@/state/store';
import { useAtlasEvents } from '@/state/useAtlasEvents';
import { useTourPlayer } from '@/state/useTourPlayer';
import { useUrlSync } from '@/state/useUrlSync';
import { AtlasCanvas } from './AtlasCanvas';
import { Attribution } from './Attribution';
import { DebugStats } from './DebugStats';
import { HoverTooltip } from './HoverTooltip';
import { Hud } from './Hud';
import { InfoPanel } from './InfoPanel';
import { PlacesInView } from './PlacesInView';
import { SearchBox } from './SearchBox';
import { TourMenu } from './TourMenu';
import { TourPlayer } from './TourPlayer';

export type CityAtlasProps = {
  slug: string;
  name: string;
  /** The city's local word for a subdivision, e.g. "barangay". */
  subdivisionLabel: string;
  /** The simulated traffic's vehicle mix (the city pack's `traffic`). */
  traffic?: TrafficMix | undefined;
  /** The winds by season (the city pack's `climate`). */
  climate?: ClimateConfig | undefined;
  landmarks: readonly Landmark[];
  art: readonly LandmarkArt[];
  tours: readonly Tour[];
};

/** One city's atlas: the map and everything around it, with the view mirrored in the URL. */
export function CityAtlas({
  slug,
  name,
  subdivisionLabel,
  traffic,
  climate,
  landmarks,
  art,
  tours,
}: CityAtlasProps) {
  useEffect(() => {
    useAtlasStore.getState().setCity(slug);
  }, [slug]);
  useUrlSync();
  useAtlasEvents();
  useTourPlayer(tours);

  return (
    <>
      <PlacesInView />
      <AtlasCanvas
        slug={slug}
        name={name}
        subdivisionLabel={subdivisionLabel}
        traffic={traffic}
        climate={climate}
      />
      <Hud city={slug} subdivisionLabel={subdivisionLabel} climate={climate} />
      <SearchBox city={slug} subdivisionLabel={subdivisionLabel} />
      <TourMenu />
      <HoverTooltip />
      <InfoPanel city={slug} subdivisionLabel={subdivisionLabel} landmarks={landmarks} art={art} />
      <TourPlayer />
      <Attribution />
      <DebugStats />
    </>
  );
}
