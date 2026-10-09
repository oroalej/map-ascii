/**
 * What a visible fixture cell reports (fixtures.ts `FixtureVisibility`), passed to
 * `FixtureGrid.visible` as each cell is written, so visibility can be worked out again for a
 * moved viewport without packing again.
 */
export const FixtureSight = {
  streetlights: 1,
  trafficSignals: 2,
  lanterns: 4,
  bunting: 8,
  installations: 16,
  candles: 32,
} as const;
