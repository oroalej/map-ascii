'use client';

import type {
  RuntimeCityLife,
  RuntimeDialogueCatalog,
  ClimateConfig,
  Landmark,
  LandmarkArt,
  TrafficMix,
  Tour,
} from '@atlas/shared';
import { useEffect, useMemo } from 'react';
import { useUiStore } from '@/state/ui';
import { hasFacts } from '@/lib/landmark';
import dynamic from 'next/dynamic';
import { useAtlasStore } from '@/state/store';
import { useAtlasEvents } from '@/state/useAtlasEvents';
import { useTourPlayer } from '@/state/useTourPlayer';
import { useUrlSync } from '@/state/useUrlSync';
import { Attribution } from './Attribution';
import { DebugStats } from './DebugStats';
import { HoverTooltip } from './HoverTooltip';
import { Hud } from './Hud';
import { LandmarkFacts } from './LandmarkFacts';
import { PlacesInView } from './PlacesInView';
import { SearchBox } from './SearchBox';
import { CueBubbles } from './CueBubbles';
import { TourMenu } from './TourMenu';
import { TourPlayer } from './TourPlayer';

// WebGL starts on the client; load its engine separately from the HUD and page content.
const loadCanvas = () => import('./AtlasCanvas');
// Start the renderer download in parallel with hydration when this module runs in the browser.
if (typeof window !== 'undefined') void loadCanvas();
const AtlasCanvas = dynamic(() => loadCanvas().then((m) => m.AtlasCanvas), {
  ssr: false,
});

export type CityAtlasProps = {
  slug: string;
  tilesVersion?: string | undefined;
  name: string;
  /** The city's local word for a subdivision, e.g. "barangay". */
  subdivisionLabel: string;
  /** The simulated traffic's vehicle mix (the city pack's `traffic`). */
  traffic?: TrafficMix | undefined;
  /** The winds by season (the city pack's `climate`). */
  climate?: ClimateConfig | undefined;
  /** The city's IANA time zone (the city pack's `timezone`). */
  timezone?: string | undefined;
  /** The daily rhythm of simulated traffic (the city pack's `life`). */
  cityLife?: RuntimeCityLife | undefined;
  dialogue?: RuntimeDialogueCatalog | undefined;
  /** Whether the city's street layer supplements mapped sidewalks. */
  sidewalksDerived?: boolean;
  utilitiesDerived?: boolean;
  landmarks: readonly Landmark[];
  art: readonly LandmarkArt[];
  tours: readonly Tour[];
};

/** One city's atlas: the map and everything around it, with the view mirrored in the URL. */
export function CityAtlas({
  slug,
  tilesVersion,
  name,
  subdivisionLabel,
  traffic,
  climate,
  timezone,
  cityLife,
  dialogue,
  sidewalksDerived = true,
  utilitiesDerived = false,
  landmarks,
  art,
  tours,
}: CityAtlasProps) {
  const clickable = useMemo(
    () => new Set(landmarks.filter(hasFacts).map((l) => l.id)),
    [landmarks],
  );
  useEffect(() => {
    useUiStore.setState({ clickable });
    return () => {
      if (useUiStore.getState().clickable === clickable)
        useUiStore.setState({ clickable: new Set() });
    };
  }, [clickable]);
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
        tilesVersion={tilesVersion}
        name={name}
        subdivisionLabel={subdivisionLabel}
        traffic={traffic}
        climate={climate}
        timezone={timezone}
        cityLife={cityLife}
        dialogue={dialogue}
        utilitiesDerived={utilitiesDerived}
      />
      <Hud
        dialogue={dialogue}
        city={slug}
        subdivisionLabel={subdivisionLabel}
        climate={climate}
        timezone={timezone}
        sidewalksDerived={sidewalksDerived}
        seasons={cityLife?.seasons}
      />
      <SearchBox city={slug} subdivisionLabel={subdivisionLabel} />
      <TourMenu />
      <HoverTooltip />
      <CueBubbles catalog={dialogue} />
      <LandmarkFacts
        city={slug}
        subdivisionLabel={subdivisionLabel}
        landmarks={landmarks}
        art={art}
      />
      <TourPlayer />
      <Attribution />
      <DebugStats />
    </>
  );
}
