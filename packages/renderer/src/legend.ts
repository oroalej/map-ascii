/**
 * The legend (SPEC.md §5 HUD): what each glyph on screen means. It is built from the theme and
 * the zoom bands, so it always matches the map; nothing in it is written by hand except the
 * class names (`CLASS_LABELS`).
 */
import { bandVisibility, CLASS_ZOOM, type AtlasClass } from '@atlas/shared';
import { markerClasses, markerFor, type RenderClass } from './classes';
import { CLASS_LABELS, themes, type ClassStyle, type ThemeName } from './theme';

export type LegendEntry = {
  /** The classes the entry covers (a marker and its building class share one). */
  classes: RenderClass[];
  label: string;
  /** A few representative glyphs. */
  glyphs: string;
  /** CSS color. */
  color: string;
};

/** Representative glyphs for a style: a straight run for lines, the ramp for fills. */
function sample(style: ClassStyle): string {
  switch (style.kind) {
    case 'road':
      return style.glyphs[2]!.repeat(3); // the east–west run
    case 'building':
    case 'ramp':
      return style.glyphs.join('');
    case 'water':
    case 'diagonal':
    case 'rows':
    case 'scatter':
      return style.glyphs.filter((g) => g.trim()).join('');
    case 'single':
    case 'variant':
      return style.glyphs.slice(style.kind === 'variant' ? 1 : 0).join(' ');
  }
}

const css = (hex: number) => `#${hex.toString(16).padStart(6, '0')}`;

/** Markers show whenever the classes that carry them show; the landmark marker always. */
const markerParents = new Map<RenderClass, AtlasClass[]>();
for (const [cls, marker] of Object.entries(markerFor)) {
  markerParents.set(marker, [...(markerParents.get(marker) ?? []), cls as AtlasClass]);
}

/** Whether a class shows at all at `zoom` (fading in counts). */
function visibleAt(cls: RenderClass, zoom: number): boolean {
  if ((markerClasses as readonly string[]).includes(cls)) {
    const parents = markerParents.get(cls);
    return !parents || parents.some((p) => visibleAt(p, zoom));
  }
  return bandVisibility(CLASS_ZOOM[cls as AtlasClass], zoom) > 0;
}

/**
 * The legend entries for the classes the theme draws at `zoom`, in the theme's order. Classes
 * with the same label (a school marker and school buildings) share an entry.
 */
export function legendEntries(themeName: ThemeName, zoom: number): LegendEntry[] {
  const theme = themes[themeName];
  const byLabel = new Map<string, LegendEntry>();
  for (const [cls, style] of Object.entries(theme.styles) as [RenderClass, ClassStyle][]) {
    if (!visibleAt(cls, zoom)) continue;
    const label = CLASS_LABELS[cls];
    const glyphs = sample(style);
    const existing = byLabel.get(label);
    if (existing) {
      existing.classes.push(cls);
      if (!existing.glyphs.includes(glyphs)) existing.glyphs += ` ${glyphs}`;
    } else {
      byLabel.set(label, { classes: [cls], label, glyphs, color: css(style.color) });
    }
  }
  return [...byLabel.values()];
}
