'use client';
import { useEmojiStore, loadEmojiPrefs, saveEmojiPrefs } from '@/state/emoji';

import { createAtlas, DEFAULT_CELLS, type Atlas, type CellSchedule } from '@atlas/renderer';
import {
  zoomLevel,
  type RuntimeCityLife,
  type RuntimeDialogueCatalog,
  type ClimateConfig,
  type TrafficMix,
} from '@atlas/shared';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { isCityEmergency } from '@/lib/guards';
import { isDebugRequested } from '@/lib/debug';
import { parseLifeHoverPause } from '@/lib/life-hover-config';
import { SMALL_SCREEN } from '@/lib/screen';
import { listenReducedMotion, prefersReducedMotion } from '@/lib/motion';
import { lifeSettings, loadLifePrefs, saveLifePrefs, useLifeStore } from '@/state/life';
import { loadQualityPref, saveQualityPref, useQualityStore } from '@/state/quality';
import { loadSpeechPrefs, saveSpeechPrefs, useSpeechStore } from '@/state/speech';
import { useAtlasInstance, useAtlasStore } from '@/state/store';
import { isPickable, useUiStore } from '@/state/ui';
import { parseViewParams } from '@/state/url';
import { scheduleAutomaticJson } from '@/lib/startup';
import { cityJson } from '@/lib/city-json';
import { installProcessions } from '@/lib/processions';
import type { MetaState } from '@/lib/city-meta';
import styles from './AtlasCanvas.module.css';

let webgl2Supported: boolean | undefined;
const detectWebGL2 = () =>
  (webgl2Supported ??= document.createElement('canvas').getContext('webgl2') !== null);
const subscribeNoop = () => () => {};
/** Small screens keep map cells a little larger (SPEC.md §8), so glyphs stay legible. */
const SMALL_SCREEN_MIN_CELL = 6;
const lifeHoverPause = parseLifeHoverPause(process.env.NEXT_PUBLIC_LIFE_HOVER_PAUSE);

/** The map's cell sizes by zoom (SPEC.md §2 "Cell size"), with a floor on small screens. */
const cellSchedule = (small: boolean): CellSchedule =>
  small
    ? {
        ...DEFAULT_CELLS,
        steps: DEFAULT_CELLS.steps.map((s) => ({
          ...s,
          width: Math.max(s.width, SMALL_SCREEN_MIN_CELL),
        })),
      }
    : DEFAULT_CELLS;

const loadEmergency = cityJson('emergency', isCityEmergency);

export function AtlasCanvas({
  metaState,
  requestLandmarks,
  slug,
  tilesVersion,
  name,
  subdivisionLabel,
  traffic,
  climate,
  timezone,
  cityLife,
  dialogue,
  utilitiesDerived = false,
}: {
  metaState: MetaState;
  requestLandmarks?: (() => void) | undefined;
  utilitiesDerived?: boolean;
  slug: string;
  tilesVersion?: string | undefined;
  name: string;
  subdivisionLabel: string;
  traffic?: TrafficMix | undefined;
  climate?: ClimateConfig | undefined;
  timezone?: string | undefined;
  cityLife?: RuntimeCityLife | undefined;
  dialogue?: RuntimeDialogueCatalog | undefined;
}) {
  const landmarkRequest = useRef(requestLandmarks);
  useEffect(() => {
    landmarkRequest.current = requestLandmarks;
  }, [requestLandmarks]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Static export renders on the server, where we optimistically assume support.
  const supported = useSyncExternalStore(subscribeNoop, detectWebGL2, () => true);
  const meta = metaState.status === 'ready' ? metaState.meta : null;
  const atlasInstance = useAtlasInstance((state) => state.atlas);
  const level = useAtlasStore((s) => (s.camera ? zoomLevel(s.camera.zoom) : null));
  const subdivision = useUiStore((s) => s.subdivision);

  useEffect(() => {
    useUiStore.setState({ meta });
    if (!supported || !meta) {
      const status = !supported
        ? 'unsupported'
        : metaState.status === 'invalid'
          ? 'invalid'
          : 'missing';
      const startup = { city: slug, atlas: null, status } as const;
      useUiStore.setState({ startup });
      return () => {
        if (useUiStore.getState().startup === startup) useUiStore.setState({ startup: null });
      };
    }
  }, [meta, metaState.status, supported, slug]);
  useEffect(() => {
    if (!atlasInstance) return;
    let cancelled = false;
    const current = () =>
      !cancelled &&
      useAtlasInstance.getState().atlas === atlasInstance &&
      useUiStore.getState().startup?.city === slug;
    const offProcessions = scheduleAutomaticJson(slug, 'processions', () => {
      void Promise.resolve()
        .then(() => {
          if (!current()) return;
          return installProcessions(slug, atlasInstance, current);
        })
        .catch(() => {});
    });
    const offEmergency = scheduleAutomaticJson(slug, 'emergency', () => {
      void Promise.resolve()
        .then(() => {
          if (!current()) return;
          const config = cityLife?.emergency;
          if (config?.ambulance?.max || config?.police?.max || config?.fire?.max) {
            void loadEmergency(slug)
              .then((data) => {
                if (current()) atlasInstance.setEmergency(data);
              })
              .catch(() => {
                if (current()) atlasInstance.setEmergency(undefined);
              });
          }
        })
        .catch(() => {});
    });
    return () => {
      cancelled = true;
      offProcessions();
      offEmergency();
    };
  }, [slug, atlasInstance, cityLife]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !supported || !meta) return;
    const store = useAtlasStore.getState();
    // A camera already in the store (e.g. after a remount) wins; else the URL's, over the
    // city's default view. Only lat, lng, and zoom are taken from the meta: meta files built
    // before the map went flat also carry pitch and bearing.
    const { lat, lng, zoom } = meta.defaultCamera;
    const camera = store.camera ?? {
      lat,
      lng,
      zoom,
      ...parseViewParams(window.location.search).camera,
    };
    store.initCamera(camera);
    // The life layer's settings are remembered in this browser, not in the URL.
    const lifePrefs = loadLifePrefs(slug, cityLife?.seasons);
    useLifeStore.setState(lifePrefs);
    const speechPrefs = dialogue
      ? loadSpeechPrefs(slug, dialogue)
      : { enabled: false, translation: null };
    useSpeechStore.setState(speechPrefs);
    const emojiPrefs = loadEmojiPrefs(slug);
    useEmojiStore.setState(emojiPrefs);
    const quality = loadQualityPref();
    useQualityStore.setState({ choice: quality });
    let atlas: Atlas;
    try {
      atlas = createAtlas(canvas, {
        lifeHoverPause,
        quality,
        utilities: { derive: utilitiesDerived },
        tilesUrl: `/tiles/${slug}.pmtiles`,
        tilesVersion,
        theme: store.theme,
        cells: cellSchedule(window.matchMedia(SMALL_SCREEN).matches),
        bounds: meta.regionBounds,
        initialCamera: camera,
        year: store.year,
        reducedMotion: prefersReducedMotion(),
        gpuTiming: isDebugRequested(),
        profiling: isDebugRequested(),
        interactive: (feature) => {
          if (feature?.landmarkId) landmarkRequest.current?.();
          return isPickable(feature, useUiStore.getState().clickable);
        },
        life: lifeSettings(lifePrefs),
        traffic,
        climate,
        timezone,
        cityLife,
        dialogue,
        speech: speechPrefs.enabled,
        emoji: emojiPrefs.enabled,
      });
    } catch (error) {
      console.error('Could not initialize the atlas', error);
      const status = canvas.getContext('webgl2') ? 'error' : 'unsupported';
      const startup = { city: slug, atlas: null, status } as const;
      useUiStore.setState({ startup });
      return () => {
        if (useUiStore.getState().startup === startup) useUiStore.setState({ startup: null });
      };
    }
    // The atlas clamps the camera to the region; start the store from where it really is.
    store.initCamera(atlas.getCamera());
    useAtlasInstance.setState({ atlas, canvas });
    useUiStore.setState({ startup: { city: slug, atlas, status: 'drawing' }, processions: [] });
    const markReady = () => {
      if (useAtlasInstance.getState().atlas === atlas)
        useUiStore.setState({ startup: { city: slug, atlas, status: 'ready' } });
    };
    const offs = [
      useQualityStore.subscribe(({ choice }) => {
        atlas.setQuality(choice);
        saveQualityPref(choice);
      }),
      useSpeechStore.subscribe((prefs, previous) => {
        if (prefs.enabled !== previous.enabled) atlas.setSpeech(prefs.enabled);
        saveSpeechPrefs(slug, prefs);
      }),
      useEmojiStore.subscribe((prefs, previous) => {
        if (prefs.enabled !== previous.enabled) atlas.setEmoji(prefs.enabled);
        saveEmojiPrefs(slug, prefs);
      }),
      listenReducedMotion(atlas),
      atlas.on('camerachange', (next) => useAtlasStore.getState().setCamera(next)),
      atlas.on('ready', markReady),
      atlas.on('contextlost', () => {
        useUiStore.setState({ startup: { city: slug, atlas, status: 'restoring' } });
      }),
      atlas.on('contextrestored', () => {
        useUiStore.setState({ startup: { city: slug, atlas, status: 'drawing' } });
      }),
      atlas.on('procession', (run) => useUiStore.setState({ procession: run })),
      useLifeStore.subscribe((prefs) => {
        atlas.setLife(lifeSettings(prefs));
        saveLifePrefs(slug, prefs);
      }),
    ];
    // Subscribe first, then recover readiness emitted before the React effect.
    if (atlas.getStats().readyMs !== null) markReady();
    return () => {
      for (const off of offs) off();
      if (useUiStore.getState().startup?.atlas === atlas)
        useUiStore.setState({ procession: null, processions: [], startup: null });
      if (useAtlasInstance.getState().atlas === atlas)
        useAtlasInstance.setState({ atlas: null, canvas: null });
      atlas.destroy();
    };
  }, [
    supported,
    meta,
    slug,
    tilesVersion,
    traffic,
    climate,
    timezone,
    cityLife,
    dialogue,
    utilitiesDerived,
  ]);

  if (!supported) return null;
  return (
    <canvas
      ref={canvasRef}
      className={styles.canvas}
      aria-label={[
        `Map of ${name}`,
        level && `${level} level`,
        subdivision &&
          `${subdivisionLabel} ${subdivision.approximate ? 'about ' : ''}${subdivision.name}`,
      ]
        .filter(Boolean)
        .join(', ')}
      // Focusable so the map's keyboard controls (+/-, arrow keys) work.
      tabIndex={0}
    />
  );
}
