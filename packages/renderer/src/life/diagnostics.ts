/** Optional profiling data. Identities are weak and never participate in simulation decisions. */
export const CONTINUITY_EVENTS = ['attempts', 'transfers', 'births', 'revivals'] as const;
export const CONTINUITY_REJECTIONS = [
  'geometry',
  'directionCraft',
  'pose',
  'terrain',
  'occupancy',
  'capQuota',
  'localScene',
  'ownership',
] as const;
export type ContinuityRejection = (typeof CONTINUITY_REJECTIONS)[number];
export type ContinuityCounter = (typeof CONTINUITY_EVENTS)[number] | ContinuityRejection;
export type TravelerTrace = {
  id: string;
  at: number;
  tile: string;
  event: string;
  lng: number;
  lat: number;
};
export type ContinuitySample = {
  counts: Partial<Record<ContinuityCounter, number>>;
  trace: TravelerTrace[];
};
