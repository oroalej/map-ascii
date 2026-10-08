'use client';

import type { ClimateConfig, TrafficMix } from '@atlas/shared';
import { SPEECH_ZOOM, EMOJI_ZOOM } from '@atlas/shared';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useUiStore } from '@/state/ui';
import { hasFacts } from '@/lib/landmark';
import { decodeInlineRuntime } from '@/lib/inline-runtime';
import dynamic from 'next/dynamic';
import type { MetaState } from '@/lib/city-meta';
import { useLandmarks } from '@/state/useLandmarks';
import { useAtlasStore } from '@/state/store';
import { useAtlasEvents } from '@/state/useAtlasEvents';
import { useTourPlayer } from '@/state/useTourPlayer';
import { useUrlSync } from '@/state/useUrlSync';
import styles from './AtlasCanvas.module.css';
import { Attribution } from './Attribution';

import { Hud } from './Hud';

import { PlacesInView } from './PlacesInView';
import { SearchBox } from './SearchBox';

import { useTourStore } from '@/state/tour';
import { isDebugRequested } from '@/lib/debug';
import { useLifeShown } from './useProcessionPlayback';
import { TourMenu } from './TourMenu';

// WebGL starts on the client; load its engine separately from the HUD and page content.
const loadCanvas = () => import('./AtlasCanvas');
// Start the renderer download in parallel with hydration when this module runs in the browser.
if (typeof window !== 'undefined') void loadCanvas();
const AtlasCanvas = dynamic(() => loadCanvas().then((m) => m.AtlasCanvas), {
  ssr: false,
});

const TourPlayer = dynamic(() => import('./InteractionDetails').then((m) => m.TourPlayer), {
  ssr: false,
});
const LandmarkFacts = dynamic(() => import('./InteractionDetails').then((m) => m.LandmarkFacts), {
  ssr: false,
});
const DebugStats = dynamic(() => import('./InteractionDetails').then((m) => m.DebugStats), {
  ssr: false,
});
const CueBubbles = dynamic(() => import('./InteractionCues').then((m) => m.CueBubbles), {
  ssr: false,
});
const HoverTooltip = dynamic(() => import('./InteractionCues').then((m) => m.HoverTooltip), {
  ssr: false,
});
const subscribeNoop = () => () => {};

export type CityAtlasProps = {
  metaState: MetaState;
  hasTours: boolean;
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
  /** Lossless gzip/base64 transport for the existing runtime Life and dialogue objects. */
  runtimeGzip: string;
  /** Whether the city's street layer supplements mapped sidewalks. */
  sidewalksDerived?: boolean;
  utilitiesDerived?: boolean;
};

/** One city's atlas: the map and everything around it, with the view mirrored in the URL. */
export function CityAtlas({
  metaState,
  hasTours,
  slug,
  tilesVersion,
  name,
  subdivisionLabel,
  traffic,
  climate,
  timezone,
  runtimeGzip,
  sidewalksDerived = true,
  utilitiesDerived = false,
}: CityAtlasProps) {
  const { cityLife, dialogue } = useMemo(() => decodeInlineRuntime(runtimeGzip), [runtimeGzip]);
  const { landmarks, request, loaded } = useLandmarks(slug);
  const startup = useUiStore((s) => s.startup);
  const status =
    startup?.city === slug
      ? startup.status
      : metaState.status === 'ready'
        ? 'drawing'
        : metaState.status;
  const selection = useUiStore((s) => s.selection);
  const hover = useUiStore((s) => s.hover !== null || s.lifeHover !== null);
  const touring = useTourStore((s) => s.active !== null);
  const zoom = useAtlasStore((s) => s.camera?.zoom ?? 0);
  const lifeShown = useLifeShown();
  const debug = useSyncExternalStore(subscribeNoop, isDebugRequested, () => false);
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
  useTourPlayer(slug, hasTours);
  useUrlSync();
  useAtlasEvents();

  return (
    <>
      {status !== 'ready' && (
        <p
          role={
            status === 'unsupported' || status === 'invalid' || status === 'error'
              ? 'alert'
              : 'status'
          }
          className={styles.notice}
        >
          {status === 'drawing' && `Drawing ${name}…`}
          {status === 'restoring' && 'The graphics context was lost. Restoring the map…'}
          {status === 'unsupported' &&
            'ASCII Atlas needs WebGL2, which this browser does not support.'}
          {status === 'error' && 'Unable to draw the map. Reload to try again.'}
          {status === 'missing' && (
            <>
              No map data for {name} yet. Run <code>pnpm data:build -- --city {slug}</code>.
            </>
          )}
          {status === 'invalid' && (
            <>
              The map data for {name} is invalid. Rebuild it with{' '}
              <code>pnpm data:build -- --city {slug}</code>.
            </>
          )}
        </p>
      )}
      <PlacesInView />
      <AtlasCanvas
        metaState={metaState}
        requestLandmarks={loaded ? undefined : request}
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
      <TourMenu hasTours={hasTours} />
      {hover && <HoverTooltip />}
      {lifeShown && zoom >= Math.min(SPEECH_ZOOM, EMOJI_ZOOM) && <CueBubbles catalog={dialogue} />}
      {selection && (
        <LandmarkFacts city={slug} subdivisionLabel={subdivisionLabel} landmarks={landmarks} />
      )}
      {touring && <TourPlayer />}
      <Attribution />
      {debug && <DebugStats />}
    </>
  );
}
