import type { Atlas, FeatureInfo, LegendEntryId, LifeHover, ProcessionRun } from '@atlas/renderer';
import type { CityMeta, ProcessionRoute } from '@atlas/shared';
import { create } from 'zustand';

/**
 * Transient UI state that never goes in the URL: what the pointer is over, and what the
 * renderer said about the selected feature when it was picked.
 */
export type UiState = {
  /** Readiness belongs to one city and one live renderer, including context recovery. */
  startup: {
    city: string;
    atlas: Atlas | null;
    status: 'drawing' | 'ready' | 'missing' | 'invalid' | 'unsupported' | 'restoring';
  } | null;
  /** Pack landmark IDs with facts; these are distinct from selected OSM feature IDs. */
  clickable: ReadonlySet<string>;
  /** Monotonic operation counter, advanced even when the selected feature ID stays the same. */
  selectionSequence: number;
  /** The current feature selection and its input origin, owned by selectPlace. */
  selection: { id: string; origin: SelectionOrigin; sequence: number } | null;
  /** Map-click coordinates, valid only for this feature ID and selection operation. */
  anchor: { id: string; lngLat: readonly [number, number]; sequence: number } | null;
  /** Keyboard operation awaiting one heading-focus request when its shell becomes visible. */
  focusRequest: number | null;
  /** Whether the current facts shell is displayed, rather than merely eligible. */
  factsVisible: boolean;
  hover: { feature: FeatureInfo; point: [number, number] } | null;
  lifeHover: Exclude<LifeHover, { label: null }> | null;
  legendFocus: LegendEntryId | null;
  /** The selected feature as last picked, if it was picked on the map. */
  picked: FeatureInfo | null;
  /** The city's generated meta, once loaded. */
  meta: CityMeta | null;
  /** The subdivision under the view's center (HUD). */
  subdivision: { name: string; approximate: boolean } | null;
  /** The city's procession and gathering events, once the generated bundle loads. */
  processions: readonly ProcessionRoute[];
  /** The procession under way, as the renderer reports it. */
  procession: ProcessionRun | null;
};

export const useUiStore = create<UiState>()(() => ({
  startup: null,
  clickable: new Set(),
  selectionSequence: 0,
  selection: null,
  anchor: null,
  focusRequest: null,
  factsVisible: false,
  hover: null,
  lifeHover: null,
  legendFocus: null,
  picked: null,
  meta: null,
  subdivision: null,
  processions: [],
  procession: null,
}));

/** The input that initiated a selection operation. */
export type SelectionOrigin = 'pointer' | 'keyboard' | 'programmatic';

/**
 * Only landmarks with facts respond to the pointer: hovering anything else does nothing, and clicking it
 * clears the selection. Other places are still selected through search, tours, and the URL.
 */
export const isPickable = (
  feature: FeatureInfo | null,
  clickable: ReadonlySet<string>,
): feature is FeatureInfo =>
  feature !== null && feature.landmarkId !== undefined && clickable.has(feature.landmarkId);
