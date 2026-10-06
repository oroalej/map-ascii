/**
 * The legend (SPEC.md §5 HUD): what each glyph on screen means. It is built from the theme, the
 * zoom bands, and the classes the renderer reports on screen (the `classeschange` event), so it
 * always matches the map; nothing in it is written by hand except the class names
 * (`CLASS_LABELS`).
 */
import {
  bandVisibility,
  CLASS_ZOOM,
  EMOJI_ZOOM,
  MOOD_GLYPHS,
  type AtlasClass,
} from '@atlas/shared';
import { ROAD_AREA_ZOOM } from './glyphs/select';
import type { LegendFocus, LifeFocus } from './focus';
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
import { PEDESTRIAN_MASTERS } from './life/pedestrian-glyphs';
import { CAT_ICON } from './life/cats';
import { DOG_ICON } from './life/dogs';
import type { FixtureVisibility } from './life/fixtures';
import type { SeasonState } from './index';
import { fireworkShellCount } from './fireworks-layout';
import { Paint, VEHICLES } from './life/vehicles';
import {
  CLASS_LABELS,
  streetlightGlyph,
  themes,
  type ClassStyle,
  type Theme,
  type ThemeName,
} from './theme';

export type LegendEntryId =
  | 'info:emoji'
  | `info:season-${'lanterns' | 'bunting' | 'stalls' | 'installations' | 'fireworks' | 'candles' | 'visitors' | 'congregations'}`
  | `class:${RenderClass}`
  | `life:${LifeFocus}`
  | `info:${'shops' | 'fish' | 'streetlights' | 'crosswalks' | 'sidewalks' | 'stop-lines' | 'one-way' | 'traffic-signals' | 'pedestrian-signals' | 'utilities'}`;

export type LegendEntry = {
  /** Stable identity, independent of display wording and currently visible class membership. */
  id: LegendEntryId;
  /** A clickable entry's map classes and simulated-agent groups, after label merging. */
  focus?: LegendFocus;
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
    case 'seating':
      return style.glyphs.join('');
    case 'planting':
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
      return style.glyphs
        .slice(style.kind === 'variant' ? 1 : 0, style.kind === 'variant' ? 7 : undefined)
        .join(' ');
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
 * theme's person color; and an umbrella from above, its ribs darker.
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
  ];
}

/**
 * Street vendors (life/simulate.ts `Stall`) aren't a map class of their own (their carts are
 * painted as vehicles), so they have an entry of their own beside the people's: a cart and the
 * vendor who stands by it.
 */
function vendorsEntry(theme: Theme): LegendEntry {
  const paint = (p: number) => theme.vehiclePaints[p]!;
  const skin = css(theme.styles.life_person!.color);
  return {
    id: 'life:vendors',
    classes: [],
    label: 'Street vendors (simulated)',
    glyphs: '',
    color: css(paint(Paint.orange)),
    icons: [
      { pixels: STALL_ICON, paint: css(paint(Paint.orange)), tone: skin },
      { pixels: FIGURE_MASTERS.adult[10]!, paint: css(paint(Paint.green)), tone: skin },
    ],
  };
}

/**
 * Streetlights (life/lights.ts) aren't a map class, so they have an entry of their own, in their
 * lamps' warm color (shaders/glyph.ts `LAMP`).
 */
export const STREETLIGHTS_ENTRY: Readonly<LegendEntry> = {
  id: 'info:streetlights',
  classes: [],
  label: 'Streetlights',
  glyphs: streetlightGlyph,
  color: '#ffc773',
};
/** The roads streetlights line. */
const litRoads: readonly RenderClass[] = ['road_major', 'road_mid'];

/** Match the map's hulls and outriggers rather than the old diamond placeholder. */
function boatIcons(theme: Theme): LegendIcon[] {
  return (['motorboat', 'banca'] as const).map((kind) => ({
    pixels: VEHICLES[kind].plan.map((row) =>
      row.replace(/[A-Z]/g, (c) => (c === 'R' || c === 'G' ? 'o' : '#')),
    ),
    paint: css(theme.vehiclePaints[Paint.cream]!),
    tone: css(theme.vehiclePaints[Paint.orange]!),
  }));
}

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

const classAliases: Partial<Record<RenderClass, RenderClass>> = {
  tree_crown: 'tree',
  marker_religious: 'building_religious',
  marker_school: 'building_school',
  marker_hospital: 'building_hospital',
  marker_station: 'building_station',
};
const lifeGroups: Partial<Record<RenderClass, LifeFocus>> = {
  life_vehicle: 'traffic',
  life_person: 'people',
  life_boat: 'boats',
  life_train: 'trains',
  life_bird: 'birds',
};

/**
 * The legend entries for the classes the theme draws at `zoom`, in the theme's order. Classes
 * in the same explicit category (a school marker and school buildings) share an entry. With `present`
 * (the classes on screen), a class drawn in cells is listed only if it is there. The life
 * layer's agents are listed only with `life`. Static hardware follows `fixtureschange`,
 * independently of Life/daylight; `lights` remains an illumination flag and a legacy fallback.
 */
export function legendEntries(
  themeName: ThemeName,
  zoom: number,
  present?: readonly RenderClass[],
  {
    life = false,
    emoji = false,
    lights = false,
    sidewalksDerived = true,
    fixtures,
    season,
  }: {
    life?: boolean;
    emoji?: boolean;
    lights?: boolean;
    sidewalksDerived?: boolean;
    fixtures?: Pick<
      FixtureVisibility,
      'streetlights' | 'trafficSignals' | 'pedestrianSignals' | 'seasonal'
    > & {
      utilities?: boolean;
    };
    season?: SeasonState | null;
  } = {},
): LegendEntry[] {
  const theme = themes[themeName];
  const onScreen = present && new Set(present);
  const byId = new Map<LegendEntryId, LegendEntry>();
  for (const [cls, style] of Object.entries(theme.styles) as [RenderClass, ClassStyle][]) {
    if (!life && (lifeClasses as readonly string[]).includes(cls)) continue;
    if (!visibleAt(cls, zoom)) continue;
    if (onScreen && isCellClass(cls) && !onScreen.has(cls)) continue;
    // Trains only run where there is track on screen.
    if (cls === 'life_train' && onScreen && !onScreen.has('rail')) continue;
    const canonical = classAliases[cls] ?? cls;
    const group = lifeGroups[cls];
    const id: LegendEntryId = group ? `life:${group}` : `class:${canonical}`;
    const label = CLASS_LABELS[canonical];
    const glyphs = sample(style);
    const existing = byId.get(id);
    if (existing) {
      existing.classes.push(cls);
      if (!existing.glyphs.includes(glyphs)) existing.glyphs += ` ${glyphs}`;
    } else {
      const entry: LegendEntry = { id, classes: [cls], label, glyphs, color: css(style.color) };
      if (cls === 'life_person') entry.icons = peopleIcons(theme);
      if (cls === 'life_boat') entry.icons = boatIcons(theme);
      byId.set(id, entry);
    }
  }
  const entries = [...byId.values()];
  if ((!onScreen || onScreen.has('furniture')) && visibleAt('furniture', zoom))
    entries.push({
      id: 'info:shops',
      classes: [],
      label: 'Shops',
      glyphs: '¤',
      color: css(theme.awningPaints[0]!),
    });
  // Vendors show wherever people do, from the same zoom.
  const people = entries.findIndex((e) => e.id === 'life:people');
  if (people >= 0) entries.splice(people + 1, 0, vendorsEntry(theme));
  if (life && zoom >= 17.5) {
    const paint = css(theme.vehiclePaints[Paint.orange]!);
    entries.push({
      id: 'life:pets',
      classes: [],
      label: 'Cats and dogs (simulated)',
      glyphs: '',
      color: paint,
      icons: [DOG_ICON, CAT_ICON].map((rows) => ({
        pixels: rows,
        paint,
        tone: dim(theme.vehiclePaints[Paint.orange]!, 0.5),
      })),
    });
  }
  if (
    life &&
    zoom >= 18 &&
    (!onScreen || onScreen.has('water_river') || onScreen.has('water_area'))
  )
    entries.push({
      id: 'info:fish',
      classes: [],
      label: 'Fish (simulated)',
      glyphs: '◊ ( )',
      color: css(theme.styles.water_river?.color ?? theme.label),
    });
  if (life && emoji && zoom >= EMOJI_ZOOM) {
    const pets = entries.findIndex((e) => e.id === 'life:pets');
    entries.splice(pets + 1, 0, {
      id: 'info:emoji',
      classes: [],
      label: 'Moods (simulated)',
      glyphs: `${MOOD_GLYPHS.happy} ${MOOD_GLYPHS.sleeping}`,
      color: css(theme.label),
    });
  }
  if (
    fixtures
      ? fixtures.streetlights
      : lights && (!onScreen || litRoads.some((cls) => onScreen.has(cls)))
  ) {
    entries.push({
      ...STREETLIGHTS_ENTRY,
      classes: [],
      glyphs: zoom >= 18.5 ? '▪─▫' : streetlightGlyph,
      color: lights ? STREETLIGHTS_ENTRY.color : css(theme.fixturePaints[0]!),
    });
  }
  const roads =
    !onScreen ||
    ['road_major', 'road_mid', 'road_minor'].some((c) => onScreen.has(c as RenderClass));
  if (roads && zoom >= ROAD_AREA_ZOOM)
    entries.push({
      id: 'info:crosswalks',
      classes: [],
      label: 'Crosswalks (mapped or simulated)',
      glyphs: '═ ║',
      color: css(theme.styles.road_mid!.color),
    });
  if (roads && zoom >= ROAD_AREA_ZOOM)
    entries.push(
      {
        id: 'info:sidewalks',
        classes: [],
        label: sidewalksDerived ? 'Sidewalks (partly derived)' : 'Sidewalks (mapped)',
        glyphs: '·',
        color: css(theme.styles.path!.color),
      },
      {
        id: 'info:stop-lines',
        classes: [],
        label: 'Stop lines',
        glyphs: '─',
        color: css(theme.styles.road_mid!.color),
      },
      {
        id: 'info:one-way',
        classes: [],
        label: 'One-way',
        glyphs: '→',
        color: css(theme.styles.road_mid!.color),
      },
    );
  if (fixtures ? fixtures.trafficSignals : roads && life && zoom >= 17)
    entries.push({
      id: 'info:traffic-signals',
      classes: [],
      label: 'Traffic signals (simulated phases)',
      glyphs: zoom >= 18.5 ? '○○○' : '•',
      color: css(theme.fixturePaints[5]!),
    });
  if (fixtures?.pedestrianSignals)
    entries.push({
      id: 'info:pedestrian-signals',
      classes: [],
      label: 'Pedestrian signals (synced with traffic signals)',
      glyphs: '',
      color: css(theme.fixturePaints[5]!),
      icons: [
        {
          pixels: PEDESTRIAN_MASTERS.stop,
          paint: css(theme.fixturePaints[3]!),
          tone: css(theme.fixturePaints[3]!),
        },
        {
          pixels: PEDESTRIAN_MASTERS.walk,
          paint: css(theme.fixturePaints[5]!),
          tone: css(theme.fixturePaints[5]!),
        },
      ],
    });
  if (fixtures?.utilities)
    entries.push({
      id: 'info:utilities',
      classes: [],
      label: 'Utility poles and wires (illustrative)',
      glyphs: zoom >= 19.5 ? '●╳∞' : '●─',
      color: css(theme.fixturePaints[7]!),
    });
  if (season?.labels.candles && fixtures?.seasonal?.candles)
    entries.push({
      id: 'info:season-candles',
      classes: [],
      label: season.labels.candles,
      glyphs: '',
      color: '#ffb347',
      icons: [
        {
          pixels: ['..#..', '.###.', '..#..', '.ooo.', '.ooo.', '.ooo.'],
          paint: '#ffb347',
          tone: '#f2dfb0',
        },
      ],
    });
  for (const kind of ['visitors', 'congregations'] as const)
    if (season?.labels[kind] && life && bandVisibility(LIFE_ZOOM.person, zoom) > 0)
      entries.push({
        id: `info:season-${kind}`,
        classes: [],
        label: `${season.labels[kind]} (simulated)`,
        glyphs: '',
        color: css(theme.styles.life_person!.color),
        icons: peopleIcons(theme),
      });
  if (season?.labels.lanterns && fixtures?.seasonal?.lanterns)
    entries.push({
      id: 'info:season-lanterns',
      classes: [],
      label: season.labels.lanterns,
      glyphs: '★',
      color: css(theme.fixturePaints[9]!),
    });
  if (season?.labels.fireworks && fireworkShellCount(zoom))
    entries.push({
      id: 'info:season-fireworks',
      classes: [],
      label: `${season.labels.fireworks} (illustrative)`,
      glyphs: '* + ·',
      color: '#ffca46',
    });
  if (season?.labels.installations && fixtures?.seasonal?.installations)
    entries.push({
      id: 'info:season-installations',
      classes: [],
      label: `${season.labels.installations} (illustrative)`,
      glyphs: '\u2736\u2605',
      color: css(theme.fixturePaints[9]!),
    });
  if (season?.labels.bunting && fixtures?.seasonal?.bunting)
    entries.push({
      id: 'info:season-bunting',
      classes: [],
      label: season.labels.bunting,
      glyphs: '▼▽',
      color: css(theme.fixturePaints[8]!),
    });
  if (
    season?.labels.stalls &&
    life &&
    zoom >= 17.5 &&
    (!onScreen || onScreen.has('path') || onScreen.has('park'))
  )
    entries.push({
      ...vendorsEntry(theme),
      id: 'info:season-stalls',
      label: `${season.labels.stalls} (simulated)`,
    });
  for (const entry of entries) {
    if (entry.id.startsWith('info:season-')) continue;
    const classes = entry.classes.filter((cls) => isCellClass(cls));
    const life = entry.classes.flatMap((cls) => (lifeGroups[cls] ? [lifeGroups[cls]] : []));
    if (entry.id === 'life:vendors') life.push('vendors');
    if (entry.id === 'life:pets') life.push('pets');
    if (classes.length || life.length) entry.focus = { classes, life };
  }
  return entries;
}
