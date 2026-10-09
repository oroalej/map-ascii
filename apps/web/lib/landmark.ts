import type { Landmark } from '@atlas/shared';

/** Facts in a city pack are the only pointer eligibility rule. */
export const hasFacts = (landmark: Landmark) => landmark.facts !== undefined;

/** A curated outline's feature id is its landmark id; other landmarks sit on their OSM feature. */
export const clickableLandmark = (id: string | null, landmarks: readonly Landmark[]) =>
  landmarks.find((landmark) => (landmark.osm_id ?? landmark.id) === id && hasFacts(landmark));
