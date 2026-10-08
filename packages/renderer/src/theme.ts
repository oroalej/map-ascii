import { PEDESTRIAN_GLYPHS } from './life/pedestrian-glyphs';
import { PROCESSION_GLYPHS } from './life/procession-glyphs';
import { FOLKLORE_GLYPHS } from './life/folklore-glyphs';
import type { RenderClass } from './classes';
import { BIRD_SPECIES_ORDER, birdGlyphs } from './life/birds';
import { dogGlyphs } from './life/dogs';
import { catGlyphs } from './life/cats';
import { figureOf, personGlyphs } from './life/people';
import { PUFF_GLYPHS } from './life/puff-style';
import { PAINT_COUNT, vehicleGlyphs } from './life/vehicles';
import { ACCESS_GLYPHS, CANDLE_GLYPHS, SEASONAL_GLYPHS } from './life/seasonal-glyphs';

export type ThemeName = 'dark' | 'light';

export type RGBA = readonly [number, number, number, number];

/**
 * How a class picks among its glyphs (the rules live in `glyphs/select.ts`):
 * - `road`: 18 glyphs indexed by the N/E/S/W connectivity mask (0–15), then `╱` and `╲`
 * - `water`: glyph 0 at rest, with drifting crests of glyph 1
 * - `building`: a height ramp, lowest first
 * - `diagonal` / `rows` / `scatter`: area patterns by `(x + y) mod n`, `y mod n`, or a cell hash
 * - `single`: always the first glyph
 * - `ramp`: by the feature's height byte, 1 = the first glyph (terrain bands)
 * - `variant`: the glyph the feature's variant byte names (e.g. bench, fountain, flagpole)
 * - `grass`: tufts at rest (0–2 dense to thin, 7 sparse), noise-grown and tinted; in a gust of
 *   wind, blades lean right (3) or left (4) with it, or stand upright (6) when it blows along
 *   the columns, or lie flat (5)
 * - `canopy`: clumped tree crowns: a crown's center (0–2, or 5 for palms and 6–7 for conifers
 *   by the variant byte), foliage around it (3), and here and there a clearing (4); in a gust
 *   of wind, the pattern leans downwind and the foliage flutters to 8
 * - `crop`: rows by `y` (0–1) at rest; in a gust, the rows lean right (2) or left (3) and the
 *   furrows ripple flat (4)
 * - `foliage`: a tree's crown: its rim (0), its inside (1, and a dense 4 here and there); in a
 *   gust, the leaves flutter between 0 and 1
 */
export type GlyphKind =
  | 'road'
  | 'water'
  | 'building'
  | 'diagonal'
  | 'rows'
  | 'scatter'
  | 'single'
  | 'variant'
  | 'ramp'
  | 'grass'
  | 'canopy'
  | 'foliage'
  | 'crop'
  | 'seating'
  | 'planting';

export type ClassStyle = {
  kind: GlyphKind;
  glyphs: readonly string[];
  /** 0xRRGGBB */
  color: number;
  /**
   * How strongly the class tints its cells' background, 0–1 toward `color` (SPEC.md §4 "Two
   * colors per cell"). Areas get a dim fill under their glyphs, so a footprint reads as one
   * shape; lines and markers leave it unset and draw over the plain background.
   */
  fill?: number;
  /** Optional 0xRRGGBB background pigment, independent of the glyph color. */
  fillColor?: number;
};

export type Theme = {
  /** Legend ink is drawn on the same dark HUD panel in either map theme. */
  folkloreLegend: { glyph: string; color: number };
  /** Hardware, housing, warm lamp, and red/amber/green lenses. */
  fixturePaints: readonly number[];
  awningPaints: readonly number[];
  /** Canvas background as linear 0–1 RGBA. */
  background: RGBA;
  /** Label text, 0xRRGGBB (drawn over the background, which doubles as its halo). */
  label: number;
  /** Highlighted and selected features, 0xRRGGBB. */
  accent: number;
  /** Classes without a style are not drawn. */
  styles: Partial<Record<RenderClass, ClassStyle>>;
  /** The life layer's vehicle paints, 0xRRGGBB, in life/vehicles.ts `Paint` order. */
  vehiclePaints: readonly number[];
  /**
   * The birds' colors, 0xRRGGBB: body, then accent (a bill, a cap, a throat), per species in
   * life/birds.ts `BIRD_SPECIES_ORDER`.
   */
  birdPaints: readonly (readonly [number, number])[];
};

/** Connectivity-mask order: 0 none, 1 N, 2 E, 3 NE, 4 S, …, 15 all; then 16 `╱`, 17 `╲`. */
// prettier-ignore
export const singleLine = ['─', '│', '─', '└', '│', '│', '┌', '├', '─', '┘', '─', '┴', '┐', '┤', '┬', '┼', '╱', '╲'] as const;
// prettier-ignore
export const doubleLine = ['═', '║', '═', '╚', '║', '║', '╔', '╠', '═', '╝', '═', '╩', '╗', '╣', '╦', '╬', '╱', '╲'] as const;
/** Paths: `:` where the path runs north–south, `·` elsewhere. */
// prettier-ignore
/** Fences, walls, and hedges: dashed, `┆` where they run north–south. */
// prettier-ignore
export const barrierLine = ['┄', '┆', '┄', '┄', '┆', '┆', '┄', '┄', '┄', '┄', '┄', '┄', '┄', '┄', '┄', '┄', '╱', '╲'] as const;
export const pathLine = [
  '·',
  ':',
  '·',
  '·',
  ':',
  ':',
  '·',
  '·',
  '·',
  '·',
  '·',
  '·',
  '·',
  '·',
  '·',
  '·',
  '·',
  '·',
] as const;

/**
 * Railway track: two rails with crossties (`╪` across, `╫` up and down, drawn as shapes in
 * glyphs/atlas.ts), joined by the double-line corners and junctions, whose strokes line up with
 * the rails. An isolated diagonal step is `⫽` / `⑊`, a diagonal track.
 */
// prettier-ignore
export const railLine = ['╪', '╫', '╪', '╚', '╫', '╫', '╔', '╠', '╪', '╝', '╪', '╩', '╗', '╣', '╦', '╬', '⫽', '⑊'] as const;

/** Building outlines at close zoom: the line sets with `□` for a one-cell building. */
export const singleWall = ['□', ...singleLine.slice(1)] as const;
export const arrowGlyphs = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'] as const;
export const doubleWall = ['□', ...doubleLine.slice(1)] as const;

/** Admin boundaries: the city's dashed, subdivisions' dotted. */
// prettier-ignore
export const dashedLine = ['╌', '╎', '╌', '╌', '╎', '╎', '╌', '╌', '╌', '╌', '╌', '╌', '╌', '╌', '╌', '╌', '╱', '╲'] as const;

/** Terrain (Region level): one glyph per elevation band, lowest first (SPEC.md §4). */
export const terrainRamp = ['.', ':', '-', '=', '+', '*', '#', '%'] as const;

/**
 * Sextant blocks by mask (SPEC.md §4 "Edges"): bit 0 is the cell's top-left sixth, bit 1 its
 * top-right, then the middle row (bits 2, 3) and the bottom row (4, 5). Mask 0 is blank, 21 and
 * 42 are the half blocks, 63 the full block; the rest are Unicode's sextants (U+1FB00 onward, in
 * mask order, skipping those four).
 */
export const sextantGlyphs: readonly string[] = Array.from({ length: 64 }, (_, mask) => {
  if (mask === 0) return ' ';
  if (mask === 21) return '▌';
  if (mask === 42) return '▐';
  if (mask === 63) return '█';
  return String.fromCodePoint(0x1fb00 + mask - 1 - (mask > 21 ? 1 : 0) - (mask > 42 ? 1 : 0));
});

/** Rain (life/wind.ts `RAIN`): straight down, then blown right, then blown left. */
export const rainGlyphs = ['|', '\\', '/'] as const;

/** A streetlight's head (life/lights.ts), lit warm from dusk, grey when it is out. */
export const streetlightGlyph = '*';
/** Reuse line, casing, and lens glyphs for static street hardware. */
export const fixtureGlyphs = [
  '●',
  '━',
  '┃',
  '·',
  '▣',
  '∞',
  '╳',
  '┼',
  '\u2584',
  '\u263c',
  '\u2605',
  '▪',
  '─',
  '│',
  '╱',
  '╲',
  '▫',
  '○',
  '•',
  '*',
] as const;

/**
 * Grass and parks: dense, medium, and thin tufts at rest; then leaning right, leaning left, and
 * flat in the wind; upright (a wind along the columns) and a sparse tuft (glyphs/select.ts `GrassGlyph`).
 */
export const grassGlyphs = ['"', "'", ',', '/', '\\', '~', '|', '.'] as const;

/** Building ramp by height, lowest first. */
export const buildingRamp = ['░', '▒', '▓', '█'] as const;

const rgb = (hex: number): RGBA => [
  ((hex >> 16) & 0xff) / 255,
  ((hex >> 8) & 0xff) / 255,
  (hex & 0xff) / 255,
  1,
];

type Palette = Record<
  | 'river'
  | 'lake'
  | 'sea'
  | 'coast'
  | 'terrain'
  | 'adminCity'
  | 'adminSubdivision'
  | 'roadMajor'
  | 'roadMid'
  | 'roadMinor'
  | 'path'
  | 'building'
  | 'religious'
  | 'school'
  | 'hospital'
  | 'market'
  | 'rail'
  | 'station'
  | 'park'
  | 'trees'
  | 'grass'
  | 'crown'
  | 'farmland'
  | 'landmark'
  | 'monument'
  | 'part'
  | 'tree'
  | 'barrier'
  | 'furniture'
  | 'parking'
  | 'pitch'
  | 'vehicle'
  | 'person'
  | 'boat'
  | 'train'
  | 'bird'
  | 'label'
  | 'accent',
  number
> & {
  /** In life/vehicles.ts `Paint` order. */
  vehiclePaints: readonly number[];
  /** In life/birds.ts `BIRD_SPECIES_ORDER`. */
  birdPaints: readonly (readonly [number, number])[];
};

/** Glyphs and classes from SPEC.md §4; only the colors differ between themes. */
function makeTheme(background: number, c: Palette): Theme {
  if (c.vehiclePaints.length !== PAINT_COUNT) throw new Error('one color per vehicle paint');
  if (c.birdPaints.length !== BIRD_SPECIES_ORDER.length) throw new Error('colors per bird species');
  return {
    background: rgb(background),
    folkloreLegend: { glyph: '◌', color: 0xb9efff },
    label: c.label,
    accent: c.accent,
    fixturePaints:
      background > 0x7fffff
        ? [
            0x555b63, 0x242830, 0xffe6ad, 0xc92825, 0xb87900, 0x12823f, 0x8d8a82, 0x34383e,
            0xb93340, 0xb8831a, 0x25785a,
          ]
        : [
            0xaab2bd, 0x303641, 0xffebba, 0xff5147, 0xffba3a, 0x58df87, 0xc9c5bb, 0x6f7782,
            0xf05b5b, 0xffd26f, 0x7ccf9d,
          ],
    vehiclePaints: c.vehiclePaints,
    awningPaints:
      background > 0x7fffff
        ? [0x9f382d, 0x746344, 0x17695a, 0x746344, 0x315e9d, 0x746344, 0x87611d, 0x746344]
        : [0xeb8876, 0xf2deb5, 0x71b6a2, 0xf2deb5, 0x85a8e0, 0xf2deb5, 0xd8b56b, 0xf2deb5],
    birdPaints: c.birdPaints,
    styles: {
      // Thin runs draw as strokes (glyphs/select.ts waterStrokeVariant).
      water_river: {
        kind: 'water',
        glyphs: ['~', '≈', '(', ')', '╱', '╲'],
        color: c.river,
        fill: 0.16,
      },
      water_stream: { kind: 'water', glyphs: ['~', '≈', '(', ')', '╱', '╲'], color: c.river },
      water_area: { kind: 'water', glyphs: ['≈', '~'], color: c.lake, fill: 0.2 },
      water_sea: { kind: 'water', glyphs: ['≈', '~'], color: c.sea, fill: 0.2 },
      coastline: { kind: 'road', glyphs: singleLine, color: c.coast },
      terrain: { kind: 'ramp', glyphs: terrainRamp, color: c.terrain },
      admin_city: { kind: 'road', glyphs: dashedLine, color: c.adminCity },
      admin_subdivision: { kind: 'road', glyphs: pathLine, color: c.adminSubdivision },
      road_major: { kind: 'road', glyphs: doubleLine, color: c.roadMajor, fill: 0.1 },
      road_mid: { kind: 'road', glyphs: singleLine, color: c.roadMid, fill: 0.1 },
      road_minor: { kind: 'road', glyphs: singleLine, color: c.roadMinor, fill: 0.1 },
      path: { kind: 'road', glyphs: pathLine, color: c.path },
      rail: { kind: 'road', glyphs: railLine, color: c.rail },
      building: { kind: 'building', glyphs: buildingRamp, color: c.building, fill: 0.22 },
      building_religious: {
        kind: 'building',
        glyphs: buildingRamp,
        color: c.religious,
        fill: 0.22,
      },
      building_school: { kind: 'building', glyphs: buildingRamp, color: c.school, fill: 0.22 },
      building_hospital: { kind: 'building', glyphs: buildingRamp, color: c.hospital, fill: 0.22 },
      building_market: { kind: 'building', glyphs: buildingRamp, color: c.market, fill: 0.22 },
      building_station: { kind: 'building', glyphs: buildingRamp, color: c.station, fill: 0.22 },
      // Landmark parts seen from above: belfries, domes, a monument's tiered base.
      building_part: { kind: 'building', glyphs: buildingRamp, color: c.part, fill: 0.3 },
      building_woodwork: {
        kind: 'building',
        glyphs: buildingRamp,
        color: background > 0x7fffff ? 0x70513b : 0xb99570,
        fill: 0.3,
      },
      park: { kind: 'grass', glyphs: grassGlyphs, color: c.park, fill: 0.12 },
      paving: { kind: 'scatter', glyphs: [' ', ' ', ' ', '·'], color: c.furniture, fill: 0.14 },
      seating: {
        kind: 'seating',
        glyphs: ['▒'],
        color: background > 0x7fffff ? 0x676d70 : 0xb8bec2,
        fill: 0.65,
      },
      shrubs: { kind: 'scatter', glyphs: ['%', '*', '%'], color: c.trees, fill: 0.25 },
      planting: {
        kind: 'planting',
        glyphs: [...grassGlyphs, ' '],
        color: c.grass,
        fillColor: background > 0x7fffff ? 0x826a50 : 0x95734e,
        fill: 0.4,
      },
      grass: { kind: 'grass', glyphs: grassGlyphs, color: c.grass, fill: 0.08 },
      trees: {
        kind: 'canopy',
        glyphs: ['♣', '♠', '♣', '&', ',', 'Ψ', '↑', '♠', '%'],
        color: c.trees,
        fill: 0.1,
      },
      // A tree's crown around its trunk: its rim is `%` and its inside `&`, with a dense `@` here
      // and there (glyphs/select.ts `CrownGlyph`). In the wind it sways (the
      // cell shader) and its leaves flutter between `%` and `&`.
      tree_crown: {
        kind: 'foliage',
        glyphs: ['%', '&', '&', '&', '@'],
        color: c.crown,
        fill: 0.14,
      },
      farmland: {
        kind: 'crop',
        glyphs: ['≡', "'", '/', '\\', '~', '≈', '.', ',', '·', ':'],
        color: c.farmland,
        fill: 0.08,
      },
      marker_religious: { kind: 'single', glyphs: ['†'], color: c.religious },
      marker_school: { kind: 'single', glyphs: ['⌂'], color: c.school },
      marker_hospital: { kind: 'single', glyphs: ['+'], color: c.hospital },
      marker_market: { kind: 'single', glyphs: ['$'], color: c.market },
      marker_station: { kind: 'single', glyphs: ['Ħ'], color: c.station },
      marker_landmark: { kind: 'single', glyphs: ['◆'], color: c.landmark },
      monument: { kind: 'single', glyphs: ['▲'], color: c.monument },
      // Variant 0 is an unknown kind; then palm, needleleaved, broadleaved (classes.ts TREE_KINDS).
      tree: { kind: 'variant', glyphs: ['♣', 'Ψ', '↑', '♣'], color: c.tree },
      barrier: { kind: 'road', glyphs: barrierLine, color: c.barrier },
      entrance: { kind: 'single', glyphs: ['▪'], color: c.monument },
      // Variant 0 is unknown furniture; then bench, fountain, flagpole (classes.ts variantCode).
      furniture: {
        kind: 'variant',
        glyphs: ['•', '╥', '○', '¶', '┬', '▤', '⌂', '═', '•', '¤', '¤', '¤', '─', '•', '*'],
        color: c.furniture,
      },
      parking: { kind: 'rows', glyphs: ['▫', '·'], color: c.parking, fill: 0.1 },
      pitch: { kind: 'rows', glyphs: ['─', ' '], color: c.pitch, fill: 0.12 },
      // The life layer (life/simulate.ts) picks among these itself: a vehicle by its heading on
      // screen (across, then up or down), a bird by its wing beat. Vehicles take their glyphs
      // and paints from life/vehicles.ts and `vehiclePaints`, and people their figures from
      // life/people.ts, and birds theirs from life/birds.ts; these are the legend's (a bird's far
      // out: wings spread, raised, and sitting).
      life_vehicle: { kind: 'single', glyphs: ['▬', '▮'], color: c.vehicle },
      life_person: { kind: 'single', glyphs: ['☺'], color: c.person },
      life_boat: { kind: 'single', glyphs: ['◊'], color: c.boat },
      life_train: { kind: 'single', glyphs: ['▬', '▮'], color: c.train },
      life_bird: { kind: 'single', glyphs: ['v', '-', '·'], color: c.bird },
    },
  };
}

export const themes: Record<ThemeName, Theme> = {
  dark: makeTheme(0x04050a, {
    river: 0x3fc8e0,
    lake: 0x2f6fc0,
    sea: 0x1d4f94,
    coast: 0xc9b98f,
    terrain: 0x8a7a68,
    adminCity: 0xc58fd6,
    adminSubdivision: 0x7d6b88,
    roadMajor: 0xf4e8cc,
    roadMid: 0xb9bac2,
    roadMinor: 0x7a7c86,
    path: 0x50535c,
    building: 0xa38d74,
    religious: 0xe2b845,
    school: 0x7ea8e0,
    hospital: 0xe57c94,
    market: 0xe98a45,
    rail: 0x9a8f86,
    station: 0xc8685a,
    park: 0x5aad5a,
    trees: 0x3e9150,
    grass: 0x8cbf5e,
    crown: 0x3a9a4c,
    farmland: 0xa9b84c,
    landmark: 0xff6fae,
    monument: 0xd9cbb0,
    part: 0xe6dcc4,
    tree: 0x4fae5c,
    barrier: 0x8a7f6e,
    furniture: 0xc9c2b2,
    parking: 0x6d7080,
    pitch: 0x6fa86a,
    vehicle: 0xff7a5c,
    person: 0xf2d7a6,
    boat: 0xe8f4ff,
    train: 0xf08a2c,
    bird: 0xdfe3ea,
    label: 0xf6f1e4,
    accent: 0xffd35c,
    // white, silver, graphite, red, maroon, blue, sky, yellow, green, orange, purple, chrome,
    // cream, teal, pink
    // prettier-ignore
    vehiclePaints: [
      0xeeeeea, 0xb4bac4, 0x6c7380, 0xe8483c, 0xa8303a, 0x3f7ee8, 0x7cc4ef, 0xf2c62e,
      0x3fb56a, 0xf08a2c, 0xa66ee0, 0xd8dde6, 0xe9dcb8, 0x2fb5a8, 0xf07aa8,
    ],
    // maya, swallow, pigeon, egret, bat (a dim violet gray, so it shows on the night map)
    birdPaints: [
      [0xb58a5c, 0x4a3426],
      [0x5a7cc8, 0xe0874a],
      [0x9aa3b4, 0x5e6a80],
      [0xf4f6f2, 0xf2c62e],
      [0x9a8fb8, 0x544a6c],
    ],
  }),
  light: makeTheme(0xf4f1e8, {
    river: 0x137f9a,
    lake: 0x1f4f95,
    sea: 0x173f78,
    coast: 0x7a6a40,
    terrain: 0x8c7b66,
    adminCity: 0x8a3fa3,
    adminSubdivision: 0x9c8aa8,
    roadMajor: 0x2a2018,
    roadMid: 0x4d4d55,
    roadMinor: 0x7d7d86,
    path: 0xa4a39c,
    building: 0x8a6e52,
    religious: 0xa87a00,
    school: 0x2f5f9e,
    hospital: 0xb23b60,
    market: 0xb85418,
    rail: 0x5e5048,
    station: 0x9a3a2c,
    park: 0x3d8a3d,
    trees: 0x2a6e38,
    grass: 0x5f8f2c,
    crown: 0x236a36,
    farmland: 0x7c8a1c,
    landmark: 0xc8246e,
    monument: 0x6b5a3e,
    part: 0x5e5240,
    tree: 0x2d7a3a,
    barrier: 0x7a6d58,
    furniture: 0x4f4a40,
    parking: 0x8a8d98,
    pitch: 0x4c8a48,
    vehicle: 0xc2361c,
    person: 0x7a4a1e,
    boat: 0x0d4f6e,
    train: 0xd06a10,
    bird: 0x3a3f4a,
    label: 0x16130e,
    accent: 0xc2410c,
    // Deeper, so light cars still show on the pale map.
    // prettier-ignore
    vehiclePaints: [
      0xc9c5ba, 0x9aa0aa, 0x3d434c, 0xc8321f, 0x7e1f2a, 0x1f57c0, 0x3a8fc8, 0xd1a000,
      0x2b8a4a, 0xd06a10, 0x7a3fb8, 0x8a93a0, 0xc9b88a, 0x178a80, 0xd04a86,
    ],
    // Egrets a warm gray, so they still show on the pale map.
    birdPaints: [
      [0x7a5230, 0x2a1c12],
      [0x1f3f80, 0xb8501a],
      [0x5c6476, 0x2e343e],
      [0xa8a396, 0xc89a00],
      [0x3b3348, 0x1e1a26],
    ],
  }),
};

/**
 * What each class is, in words: the legend's entries and the info panel's type line (English
 * for now; UI translations arrive in Phase 5).
 */
export const CLASS_LABELS: Readonly<Record<RenderClass, string>> = {
  water_river: 'River',
  water_stream: 'Stream or canal',
  water_area: 'Lake or pond',
  water_sea: 'Sea',
  coastline: 'Coastline',
  terrain: 'Terrain (by elevation)',
  road_major: 'Major road',
  road_mid: 'Secondary road',
  road_minor: 'Street',
  path: 'Path or alley',
  rail: 'Railway',
  building: 'Building',
  building_religious: 'Place of worship',
  building_school: 'School',
  building_hospital: 'Hospital',
  building_market: 'Market or shop',
  building_station: 'Train station',
  building_part: 'Landmark part',
  building_woodwork: 'Pergola or timber structure',
  park: 'Park or plaza',
  paving: 'Paved plaza',
  seating: 'Stone seating or planter edge',
  shrubs: 'Shrubs',
  planting: 'Soil and ground cover',
  trees: 'Woods',
  grass: 'Grass',
  tree_crown: 'Tree',
  farmland: 'Farmland',
  monument: 'Monument',
  tree: 'Tree',
  barrier: 'Fence or wall',
  entrance: 'Entrance',
  furniture: 'Street furniture, transit stop, or shelter',
  parking: 'Parking',
  pitch: 'Sports pitch',
  admin_city: 'City boundary',
  admin_subdivision: 'Subdivision boundary',
  place_label: 'Place',
  marker_religious: 'Place of worship',
  marker_school: 'School',
  marker_hospital: 'Hospital',
  marker_market: 'Market',
  marker_station: 'Train station',
  marker_landmark: 'Landmark',
  // The life layer is decoration, not data; the legend says so.
  life_vehicle: 'Traffic (simulated)',
  life_person: 'People (simulated)',
  life_boat: 'Boat (simulated)',
  life_train: 'Train (simulated)',
  life_bird: 'Birds (simulated)',
};

/** Characters labels can use: printable ASCII and the Latin-1 letters (e.g. "Peñafrancia"). */
export const labelCharacters: readonly string[] = [
  ...Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)),
  ...'ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÑÒÓÔÕÖØÙÚÛÜÝàáâãäåæçèéêëìíîïñòóôõöøùúûüýÿ',
];

/**
 * Every glyph a theme draws on the map, deduplicated: class styles, walls, sextants, vehicles,
 * and people. They
 * share the map atlas, whose indices must fit the ten-bit glyph table. Labels have their own
 * atlas (`labelCharacters`), at the label cell size.
 */
export function mapGlyphs(theme: Theme): string[] {
  const set = new Set<string>();
  for (const style of Object.values(theme.styles)) for (const g of style.glyphs) set.add(g);
  const extras = [
    ...singleWall,
    ...doubleWall,
    ...sextantGlyphs,
    ...vehicleGlyphs(),
    ...personGlyphs().filter((glyph) => {
      const figure = figureOf(glyph)!;
      return !figure.pose && figure.stage === undefined;
    }),
    ...birdGlyphs(),
    ...dogGlyphs(),
    ...catGlyphs(),
    ...rainGlyphs,
    streetlightGlyph,
    ...fixtureGlyphs,
    ...arrowGlyphs,
    ...SEASONAL_GLYPHS,
    // New social poses follow all existing map glyphs, preserving hardware and season indices.
    ...personGlyphs().filter((glyph) => figureOf(glyph)?.pose),
    // Parking labels follow all existing glyphs so legacy atlas indices stay unchanged.
    ...ACCESS_GLYPHS,
    // Canopy stages follow all earlier glyphs, retaining fixture, pose and parking indices.
    ...personGlyphs().filter((glyph) => figureOf(glyph)?.stage !== undefined),
    ...PUFF_GLYPHS,
    ...CANDLE_GLYPHS,
    ...PEDESTRIAN_GLYPHS,
    ...PROCESSION_GLYPHS,
    ...FOLKLORE_GLYPHS,
  ];
  for (const g of extras) set.add(g);
  return [...set];
}
