import type { FeatureInfo, ProcessionRun } from '@atlas/renderer';
import type { CityMeta, ProcessionRoute } from '@atlas/shared';
import { create } from 'zustand';

/**
 * Transient UI state that never goes in the URL: what the pointer is over, and what the
 * renderer said about the selected feature when it was picked.
 */
export type UiState = {
  hover: { feature: FeatureInfo; point: [number, number] } | null;
  /** The selected feature as last picked, if it was picked on the map. */
  picked: FeatureInfo | null;
  /** The city's generated meta, once loaded. */
  meta: CityMeta | null;
  /** The subdivision under the view's center (HUD). */
  subdivision: { name: string; approximate: boolean } | null;
  /** The city's river processions (its generated `<slug>.processions.json`), once loaded. */
  processions: readonly ProcessionRoute[];
  /** The procession under way, as the renderer reports it. */
  procession: ProcessionRun | null;
};

export const useUiStore = create<UiState>()(() => ({
  hover: null,
  picked: null,
  meta: null,
  subdivision: null,
  processions: [],
  procession: null,
}));

/**
 * Only landmarks respond to the pointer: hovering anything else does nothing, and clicking it
 * clears the selection. Other places are still selected through search, tours, and the URL.
 */
export const isPickable = (feature: FeatureInfo | null): feature is FeatureInfo =>
  feature !== null && feature.landmarkId !== undefined;
