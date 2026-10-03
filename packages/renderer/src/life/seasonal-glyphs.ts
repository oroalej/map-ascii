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
  carnivalRoof: 38,
  carnivalGround: 39,
  carnivalFrame: 40,
  carnivalLight: 41,
  carouselMotion: 42,
  wheelMotion: 43,
  bumperMotion: 44,
  accessSurface: 45,
} as const;
/** Appended after legacy glyphs, for clear parking-bay labels. */
export const ACCESS_GLYPHS = ['P'] as const;
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

export const SeasonalGlyph = {
  parol: SEASONAL_GLYPHS[0],
  triangleLeft: SEASONAL_GLYPHS[1],
  triangleRight: SEASONAL_GLYPHS[2],
  rectangleLeft: SEASONAL_GLYPHS[3],
  rectangleRight: SEASONAL_GLYPHS[4],
  foliage: SEASONAL_GLYPHS[5],
  bulb: SEASONAL_GLYPHS[6],
  bell: SEASONAL_GLYPHS[7],
} as const;
