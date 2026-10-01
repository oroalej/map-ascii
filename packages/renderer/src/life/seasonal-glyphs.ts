/** Import-free atlas constants avoid a theme → placement → geometry import cycle. */
export const SeasonalPart = { lantern: 23, bunting: 24 } as const;
/** Appended after every legacy glyph; the existing flag star keeps its raster and index. */
export const SEASONAL_GLYPHS = ['\ue220', '\ue221', '\ue222'] as const;
