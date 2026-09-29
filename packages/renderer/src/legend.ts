/**
 * The legend (SPEC.md §5 HUD): what each glyph on screen means. It is built from the theme, the
 * zoom bands, and the classes the renderer reports on screen (the `classeschange` event), so it
 * always matches the map; nothing in it is written by hand except the class names
 * (`CLASS_LABELS`).
 */
import { bandVisibility, CLASS_ZOOM, type AtlasClass } from '@atlas/shared';
import {
  classDepths,
  classId,
  lifeClasses,
  markerClasses,
  markerFor,
  type LifeClass,
  type RenderClass,
} from './classes';
import { LIFE_ZOOM, lifeClassFor, type AgentKind } from './life/config';
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
      return style.glyphs.slice(0, 2).join(''); // the animated pair, not the thin strokes
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

const lifeKinds = new Map(
  Object.entries(lifeClassFor).map(([kind, cls]) => [cls, kind as AgentKind]),
);

/** Whether a class shows at all at `zoom` (fading in counts). */
function visibleAt(cls: RenderClass, zoom: number): boolean {
  const lifeKind = lifeKinds.get(cls as LifeClass);
  if (lifeKind) return bandVisibility(LIFE_ZOOM[lifeKind], zoom) >= 1;
  if ((markerClasses as readonly string[]).includes(cls)) {
    const parents = markerParents.get(cls);
    return !parents || parents.some((p) => visibleAt(p, zoom));
  }
  return bandVisibility(CLASS_ZOOM[cls as AtlasClass], zoom) > 0;
}

const depths = classDepths();
/** Whether the cell pass draws a class into cells (so a read of the class buffer can see it). */
const isCellClass = (cls: RenderClass) => depths[classId(cls)]! <= 1;

/**
 * The legend entries for the classes the theme draws at `zoom`, in the theme's order. Classes
 * with the same label (a school marker and school buildings) share an entry. With `present`
 * (the classes on screen), a class drawn in cells is listed only if it is there. The life
 * layer's agents are listed only with `life` (the layer is on).
 */
export function legendEntries(
  themeName: ThemeName,
  zoom: number,
  present?: readonly RenderClass[],
  { life = false }: { life?: boolean } = {},
): LegendEntry[] {
  const theme = themes[themeName];
  const onScreen = present && new Set(present);
  const byLabel = new Map<string, LegendEntry>();
  for (const [cls, style] of Object.entries(theme.styles) as [RenderClass, ClassStyle][]) {
    if (!life && (lifeClasses as readonly string[]).includes(cls)) continue;
    if (!visibleAt(cls, zoom)) continue;
    if (onScreen && isCellClass(cls) && !onScreen.has(cls)) continue;
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
