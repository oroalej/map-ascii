import type { FeatureInfo, LegendEntryId, LifeHover, ProcessionRun } from '@atlas/renderer';
import type { CityMeta, ProcessionRoute } from '@atlas/shared';
import { create } from 'zustand';

/**
 * Transient UI state that never goes in the URL: what the pointer is over, and what the
 * renderer said about the selected feature when it was picked.
 */
export type UiState = {
  clickable: ReadonlySet<string>;
  selectionSequence: number;
  selection: { id: string; origin: SelectionOrigin; sequence: number } | null;
  anchor: { id: string; lngLat: readonly [number, number]; sequence: number } | null;
  focusRequest: number | null;
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

/**
 * Only landmarks with facts respond to the pointer: hovering anything else does nothing, and clicking it
 * clears the selection. Other places are still selected through search, tours, and the URL.
 */
export type SelectionOrigin = 'pointer' | 'keyboard' | 'programmatic';

export const isPickable = (
  feature: FeatureInfo | null,
  clickable: ReadonlySet<string>,
): feature is FeatureInfo =>
  feature !== null && feature.landmarkId !== undefined && clickable.has(feature.landmarkId);
