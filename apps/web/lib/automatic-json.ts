/** Automatic network policy shared by loader scheduling and the export budget. */
export type AutomaticJson = 'landmarks' | 'subdivisions' | 'processions' | 'emergency';
export type JsonSchedule = 'startup' | 'first-tile';
export type AutomaticJsonPolicy = Readonly<Record<AutomaticJson, JsonSchedule>>;
export const AUTOMATIC_JSON: AutomaticJsonPolicy = {
  landmarks: 'first-tile',
  subdivisions: 'first-tile',
  processions: 'first-tile',
  emergency: 'first-tile',
};
