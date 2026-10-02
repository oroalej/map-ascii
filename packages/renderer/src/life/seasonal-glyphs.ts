/** Import-free atlas constants avoid a theme → placement → geometry import cycle. */
export const SeasonalPart = {
  lantern: 23,
  bunting: 24,
  festiveTree: 32,
  festiveLight: 33,
  festiveOrnament: 34,
  festiveWire: 35,
  buildingLight: 36,
  buildingWire: 37,
} as const;
/** Appended after every legacy glyph; the existing flag star keeps its raster and index. */
export const SEASONAL_GLYPHS = [
  '\ue220',
  '\ue221',
  '\ue222',
  '\ue223',
  '\ue224',
  '\ue225',
  '\ue226',
  '\ue227',
] as const;
