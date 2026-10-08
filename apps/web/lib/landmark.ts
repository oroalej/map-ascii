import type { Landmark } from '@atlas/shared';

/** Facts in a city pack are the only pointer eligibility rule. */
export const hasFacts = (landmark: Landmark) => landmark.facts !== undefined;

export const clickableLandmark = (id: string | null, landmarks: readonly Landmark[]) =>
  landmarks.find((landmark) => (landmark.osm_id ?? landmark.id) === id && hasFacts(landmark));
