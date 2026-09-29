import type { RenderClass } from './classes';

export type ThemeName = 'dark' | 'light';

export type RGBA = readonly [number, number, number, number];

/**
 * How a class picks among its glyphs (the rules live in `glyphs/select.ts`):
 * - `road`: 18 glyphs indexed by the N/E/S/W connectivity mask (0–15), then `╱` and `╲`
 * - `water`: alternates between the glyphs per cell over time
 * - `building`: a height ramp, lowest first
 * - `diagonal` / `rows` / `scatter`: area patterns by `(x + y) mod n`, `y mod n`, or a cell hash
 * - `single`: always the first glyph
 * - `variant`: the glyph the feature's variant byte names (e.g. bench, fountain, flagpole)
 */
export type GlyphKind =
  'road' | 'water' | 'building' | 'diagonal' | 'rows' | 'scatter' | 'single' | 'variant';

export type ClassStyle = {
  kind: GlyphKind;
  glyphs: readonly string[];
  /** 0xRRGGBB */
  color: number;
};

export type Theme = {
  /** Canvas background as linear 0–1 RGBA. */
  background: RGBA;
  /** Label text, 0xRRGGBB (drawn over the background, which doubles as its halo). */
  label: number;
  /** Classes without a style are not drawn. */
  styles: Partial<Record<RenderClass, ClassStyle>>;
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

/** Building outlines at close zoom: the line sets with `□` for a one-cell building. */
export const singleWall = ['□', ...singleLine.slice(1)] as const;
export const doubleWall = ['□', ...doubleLine.slice(1)] as const;

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
  | 'roadMajor'
  | 'roadMid'
  | 'roadMinor'
  | 'path'
  | 'building'
  | 'religious'
  | 'school'
  | 'market'
  | 'park'
  | 'trees'
  | 'farmland'
  | 'landmark'
  | 'monument'
  | 'part'
  | 'tree'
  | 'barrier'
  | 'furniture'
  | 'parking'
  | 'pitch'
  | 'label',
  number
>;

/** Glyphs and classes from SPEC.md §4; only the colors differ between themes. */
function makeTheme(background: number, c: Palette): Theme {
  return {
    background: rgb(background),
    label: c.label,
    styles: {
      water_river: { kind: 'water', glyphs: ['~', '≈'], color: c.river },
      water_area: { kind: 'water', glyphs: ['≈', '~'], color: c.lake },
      road_major: { kind: 'road', glyphs: doubleLine, color: c.roadMajor },
      road_mid: { kind: 'road', glyphs: singleLine, color: c.roadMid },
      road_minor: { kind: 'road', glyphs: singleLine, color: c.roadMinor },
      path: { kind: 'road', glyphs: pathLine, color: c.path },
      building: { kind: 'building', glyphs: buildingRamp, color: c.building },
      building_religious: { kind: 'building', glyphs: buildingRamp, color: c.religious },
      building_school: { kind: 'building', glyphs: buildingRamp, color: c.school },
      building_market: { kind: 'building', glyphs: buildingRamp, color: c.market },
      // Landmark parts seen from above: belfries, domes, a monument's tiered base.
      building_part: { kind: 'building', glyphs: buildingRamp, color: c.part },
      park: { kind: 'diagonal', glyphs: ['"', "'", ','], color: c.park },
      trees: { kind: 'scatter', glyphs: ['♣', '♠', '↑'], color: c.trees },
      farmland: { kind: 'rows', glyphs: ['≡', "'"], color: c.farmland },
      marker_religious: { kind: 'single', glyphs: ['†'], color: c.religious },
      marker_school: { kind: 'single', glyphs: ['⌂'], color: c.school },
      marker_market: { kind: 'single', glyphs: ['$'], color: c.market },
      marker_landmark: { kind: 'single', glyphs: ['◆'], color: c.landmark },
      monument: { kind: 'single', glyphs: ['▲'], color: c.monument },
      tree: { kind: 'single', glyphs: ['♣'], color: c.tree },
      barrier: { kind: 'road', glyphs: barrierLine, color: c.barrier },
      entrance: { kind: 'single', glyphs: ['▪'], color: c.monument },
      // Variant 0 is unknown furniture; then bench, fountain, flagpole (classes.ts variantCode).
      furniture: { kind: 'variant', glyphs: ['•', '╥', '○', '¶'], color: c.furniture },
      parking: { kind: 'rows', glyphs: ['▫', '·'], color: c.parking },
      pitch: { kind: 'rows', glyphs: ['─', ' '], color: c.pitch },
    },
  };
}

export const themes: Record<ThemeName, Theme> = {
  dark: makeTheme(0x04050a, {
    river: 0x3fc8e0,
    lake: 0x2f6fc0,
    roadMajor: 0xf4e8cc,
    roadMid: 0xb9bac2,
    roadMinor: 0x7a7c86,
    path: 0x50535c,
    building: 0xa38d74,
    religious: 0xe2b845,
    school: 0x7ea8e0,
    market: 0xe98a45,
    park: 0x5aad5a,
    trees: 0x3e9150,
    farmland: 0xa9b84c,
    landmark: 0xff6fae,
    monument: 0xd9cbb0,
    part: 0xe6dcc4,
    tree: 0x4fae5c,
    barrier: 0x8a7f6e,
    furniture: 0xc9c2b2,
    parking: 0x6d7080,
    pitch: 0x6fa86a,
    label: 0xf6f1e4,
  }),
  light: makeTheme(0xf4f1e8, {
    river: 0x137f9a,
    lake: 0x1f4f95,
    roadMajor: 0x2a2018,
    roadMid: 0x4d4d55,
    roadMinor: 0x7d7d86,
    path: 0xa4a39c,
    building: 0x8a6e52,
    religious: 0xa87a00,
    school: 0x2f5f9e,
    market: 0xb85418,
    park: 0x3d8a3d,
    trees: 0x2a6e38,
    farmland: 0x7c8a1c,
    landmark: 0xc8246e,
    monument: 0x6b5a3e,
    part: 0x5e5240,
    tree: 0x2d7a3a,
    barrier: 0x7a6d58,
    furniture: 0x4f4a40,
    parking: 0x8a8d98,
    pitch: 0x4c8a48,
    label: 0x16130e,
  }),
};

/** Characters labels can use: printable ASCII and the Latin-1 letters (e.g. "Peñafrancia"). */
export const labelCharacters: readonly string[] = [
  ...Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)),
  ...'ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÑÒÓÔÕÖØÙÚÛÜÝàáâãäåæçèéêëìíîïñòóôõöøùúûüýÿ',
];

/**
 * Every glyph a theme draws, deduplicated: map glyphs and walls first (their atlas indices
 * must fit the byte-sized glyph table), then label text.
 */
export function themeGlyphs(theme: Theme): string[] {
  const set = new Set<string>();
  for (const style of Object.values(theme.styles)) for (const g of style.glyphs) set.add(g);
  for (const g of [...singleWall, ...doubleWall, ...labelCharacters]) set.add(g);
  return [...set];
}
