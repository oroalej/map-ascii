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
  partOf,
  type LifeClass,
  type PartClass,
  type RenderClass,
} from './classes';
import { LIFE_ZOOM, lifeClassFor, type AgentKind } from './life/config';
import { FIGURE_MASTERS } from './life/people';
import { Paint } from './life/vehicles';
import {
  CLASS_LABELS,
  streetlightGlyph,
  themes,
  type ClassStyle,
  type Theme,
  type ThemeName,
} from './theme';

export type LegendEntry = {
  /** The classes the entry covers (a marker and its building class share one). */
  classes: RenderClass[];
  label: string;
  /** A few representative glyphs. */
  glyphs: string;
  /** CSS color. */
  color: string;
  /**
   * Pictures to show instead of `glyphs`, for what is drawn pixel by pixel rather than from the
   * font (people's figures, life/people.ts).
   */
  icons?: LegendIcon[];
};

/** A small pixel picture: rows of `#` (in `paint`), `o` (in `tone`), and `.` (empty). */
export type LegendIcon = { pixels: readonly string[]; paint: string; tone: string };

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
      return [...new Set(style.glyphs.filter((g) => g.trim()))].join('');
    case 'grass':
      return style.glyphs.slice(0, 3).join(''); // at rest
    case 'canopy':
      return [...new Set(style.glyphs.slice(0, 4))].join(''); // crowns and foliage
    case 'crop':
      return style.glyphs.slice(0, 2).join(''); // at rest
    case 'foliage':
      return style.glyphs.slice(0, 2).join(''); // at rest
    case 'single':
    case 'variant':
      return style.glyphs.slice(style.kind === 'variant' ? 1 : 0).join(' ');
  }
}

const css = (hex: number) => `#${hex.toString(16).padStart(6, '0')}`;

/** A color darkened to `share` of itself, as the glyph shader shades a canopy's ribs. */
const dim = (hex: number, share: number) =>
  css(
    [16, 8, 0].reduce(
      (out, shift) => out | (Math.round(((hex >> shift) & 255) * share) << shift),
      0,
    ),
  );

/**
 * A vendor's cart as the map draws it in one cell (glyphs/atlas.ts `drawStall`): an awning in
 * stripes.
 */
// prettier-ignore
const STALL_ICON = [
  '..........',
  '.########.',
  '.########.',
  '..........',
  '.########.',
  '.########.',
  '..........',
  '.########.',
  '.########.',
  '..........',
];

/**
 * People as the map draws them (life/people.ts): someone walking, in a shirt, their skin in the
 * theme's person color; an umbrella from above, its ribs darker; and a vendor's cart.
 */
function peopleIcons(theme: Theme): LegendIcon[] {
  const paint = (p: number) => theme.vehiclePaints[p]!;
  const skin = css(theme.styles.life_person!.color);
  return [
    { pixels: FIGURE_MASTERS.adult[10]!, paint: css(paint(Paint.red)), tone: skin },
    {
      pixels: FIGURE_MASTERS.umbrella[10]!,
      paint: css(paint(Paint.blue)),
      tone: dim(paint(Paint.blue), 0.6),
    },
    { pixels: STALL_ICON, paint: css(paint(Paint.orange)), tone: skin },
  ];
}

/**
 * Streetlights (life/lights.ts) aren't a map class, so they have an entry of their own, in their
 * lamps' warm color (shaders/glyph.ts `LAMP`).
 */
export const STREETLIGHTS_ENTRY: Readonly<LegendEntry> = {
  classes: [],
  label: 'Streetlights',
  glyphs: streetlightGlyph,
  color: '#ffc773',
};
/** The roads streetlights line. */
const litRoads: readonly RenderClass[] = ['road_major', 'road_mid'];

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
  const part = partOf[cls as PartClass];
  if (part) return visibleAt(part, zoom);
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
 * layer's agents are listed only with `life` (the layer is on), and streetlights only with
 * `lights` (they are lit, the `lightschange` event) and the roads they line on screen.
 */
export function legendEntries(
  themeName: ThemeName,
  zoom: number,
  present?: readonly RenderClass[],
  { life = false, lights = false }: { life?: boolean; lights?: boolean } = {},
): LegendEntry[] {
  const theme = themes[themeName];
  const onScreen = present && new Set(present);
  const byLabel = new Map<string, LegendEntry>();
  for (const [cls, style] of Object.entries(theme.styles) as [RenderClass, ClassStyle][]) {
    if (!life && (lifeClasses as readonly string[]).includes(cls)) continue;
    if (!visibleAt(cls, zoom)) continue;
    if (onScreen && isCellClass(cls) && !onScreen.has(cls)) continue;
    // Trains only run where there is track on screen.
    if (cls === 'life_train' && onScreen && !onScreen.has('rail')) continue;
    const label = CLASS_LABELS[cls];
    const glyphs = sample(style);
    const existing = byLabel.get(label);
    if (existing) {
      existing.classes.push(cls);
      if (!existing.glyphs.includes(glyphs)) existing.glyphs += ` ${glyphs}`;
    } else {
      const entry: LegendEntry = { classes: [cls], label, glyphs, color: css(style.color) };
      if (cls === 'life_person') entry.icons = peopleIcons(theme);
      byLabel.set(label, entry);
    }
  }
  const entries = [...byLabel.values()];
  if (lights && (!onScreen || litRoads.some((cls) => onScreen.has(cls)))) {
    entries.push({ ...STREETLIGHTS_ENTRY, classes: [] });
  }
  return entries;
}
