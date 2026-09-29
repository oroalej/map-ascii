import type { FeatureInfo } from '@atlas/renderer';
import type { CityMeta } from '@atlas/shared';
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
};

export const useUiStore = create<UiState>()(() => ({
  hover: null,
  picked: null,
  meta: null,
  subdivision: null,
}));

/**
 * Classes that are backdrop rather than places: hovering or clicking them does nothing, and
 * clicking one clears the selection.
 */
const backdrop = new Set(['terrain', 'water_sea', 'coastline', 'admin_city', 'admin_subdivision']);

export const isPickable = (feature: FeatureInfo | null): feature is FeatureInfo =>
  feature !== null && !backdrop.has(feature.class);
