import { describe, expect, it } from 'vitest';
import { classId, MAX_CLASSES } from '../classes';
import { grassGlyphs, themes } from '../theme';
import {
  buildGlyphTables,
  CANOPY,
  CanopyGlyph,
  canopyCell,
  canopyLean,
  canopyVariant,
  CROP,
  CropGlyph,
  cropTone,
  cropVariant,
  CROWN,
  CrownGlyph,
  crownIsDry,
  DEFAULT_SUN,
  foliageVariant,
  GRASS,
  GUST_STEPS,
  GrassGlyph,
  grassCell,
  grassVariant,
  kindCodes,
  selectGlyph,
  STIR,
  subcellAreas,
  subcellClasses,
  SWAY,
  swayOffset,
  Tone,
  TONE,
  toneColor,
  TREE_WIND,
  treeGust,
  valueNoise,
  waterVariant,
  WIND,
  WIND_LIGHT,
  windFrom,
  DEFAULT_WIND_DIR,
  windFront,
  windGust,
  windLevel,
} from './select';

/** Every cell of a `size × size` square from (x0, y0). */
const cells = (x0: number, y0: number, size: number) =>
  Array.from(
    { length: size * size },
    (_, i) => [x0 + (i % size), y0 + Math.floor(i / size)] as const,
  );

describe('value noise', () => {
  it('stays in 0–1 and hits the lattice values exactly', () => {
    for (const [x, y] of cells(-50, 1_000_000, 40)) {
      const n = valueNoise(x, y, 16, 3);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(1);
    }
  });

  it('changes smoothly from cell to cell', () => {
    for (const [x, y] of cells(123_456, 654_321, 30)) {
      expect(Math.abs(valueNoise(x + 1, y, 48, 1) - valueNoise(x, y, 48, 1))).toBeLessThan(0.1);
    }
  });

  it('gives independent fields for different seeds', () => {
    const differs = cells(0, 0, 20).some(
      ([x, y]) => Math.abs(valueNoise(x, y, 8, 1) - valueNoise(x, y, 8, 2)) > 0.2,
    );
    expect(differs).toBe(true);
  });
});

describe('wind over grass', () => {
  const field = cells(200_000, 300_000, 64);

  it('blows between still (0) and a gust (1), with both somewhere on the map', () => {
    const gusts = field.map(([x, y]) => windGust(x, y, 12.5));
    for (const g of gusts) {
      expect(g).toBeGreaterThanOrEqual(0);
      expect(g).toBeLessThanOrEqual(1);
    }
    expect(gusts.filter((g) => g === 0).length).toBeGreaterThan(field.length / 2);
    // Over a stretch of time, a good share of the park feels a gust.
    const gusted = field.filter(([x, y]) =>
      Array.from({ length: 40 }, (_, t) => windGust(x, y, t * 0.5)).some((g) => g > 0.5),
    );
    expect(gusted.length).toBeGreaterThan(field.length / 5);
  });

  it.each([45, 225, 300])('moves the fronts downwind as time passes (from %i°)', (from) => {
    // A front at one cell reaches a cell `along` cells downwind `along / speed` seconds later:
    // compare the gust there and then.
    const dir = windFrom(from);
    const [ox, oy] = [Math.round(dir[0] * 4), Math.round(dir[1] * 4)];
    const along = ox * dir[0] + oy * dir[1];
    let same = 0;
    let total = 0;
    for (const [x, y] of field) {
      const now = windGust(x, y, 20, dir);
      if (now < 0.3) continue;
      total++;
      const later = windGust(x + ox, y + oy, 20 + along / WIND.speed, dir);
      if (Math.abs(later - now) < 0.35) same++;
    }
    expect(total).toBeGreaterThan(0);
    expect(same / total).toBeGreaterThan(0.6);
  });

  it('blows the way a compass bearing says it comes from', () => {
    const close = (a: readonly number[], b: readonly number[]) =>
      a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!));
    close(windFrom(0), [0, 1]); // from the north: toward the south (y down)
    close(windFrom(90), [-1, 0]); // from the east: toward the west
    close(windFrom(45), [-Math.SQRT1_2, Math.SQRT1_2]);
    close(DEFAULT_WIND_DIR, windFrom(45));
  });

  it('grows tufts at rest instead of a diagonal stripe, and holds them without wind', () => {
    const tufts = [0, 1, 2, GrassGlyph.sparse];
    const seen = new Set<number>();
    let same = 0;
    for (const [x, y] of field) {
      const v = grassVariant(x, y, 20, 0);
      expect(tufts).toContain(v);
      expect(grassVariant(x, y, 99, 0)).toBe(v);
      seen.add(v);
      // The old stripe repeated every 3 cells along a row.
      if (grassVariant(x + 3, y, 20, 0) === v) same++;
    }
    expect(seen.size).toBe(tufts.length);
    expect(same / field.length).toBeLessThan(0.8);
  });

  it('leans downwind in a gust (upright when it blows along the columns), then lies flat', () => {
    for (const from of [45, 270, 0]) {
      const dir = windFrom(from);
      const lean =
        Math.abs(dir[0]) < GRASS.uprightBelow
          ? GrassGlyph.upright
          : dir[0] > 0
            ? GrassGlyph.leanRight
            : GrassGlyph.leanLeft;
      const seen = new Set(field.map(([x, y]) => grassVariant(x, y, 20, 1, dir)));
      expect(seen.has(lean)).toBe(true);
      for (const other of [GrassGlyph.leanRight, GrassGlyph.leanLeft, GrassGlyph.upright]) {
        if (other !== lean) expect(seen.has(other)).toBe(false);
      }
      for (const v of seen) expect(v).toBeLessThan(grassGlyphs.length);
    }
  });

  it('bends at its gust steps, toward where the wind goes', () => {
    const east = windFrom(270);
    expect(grassCell(5, 5, GUST_STEPS[0], east).variant).toBe(GrassGlyph.leanRight);
    expect(grassCell(5, 5, GUST_STEPS[1], east).variant).toBe(GrassGlyph.flat);
    expect(grassCell(5, 5, GUST_STEPS[0], windFrom(90)).variant).toBe(GrassGlyph.leanLeft);
  });

  it('draws parks and grass with it', () => {
    const tables = buildGlyphTables(themes.dark, (g) => g.codePointAt(0)! % 256);
    expect(tables.kinds[classId('park')]).toBe(kindCodes.grass);
    expect(tables.kinds[classId('grass')]).toBe(kindCodes.grass);
    const at = (time: number, wind: number) =>
      selectGlyph(themes.dark, 'grass', {
        x: 10,
        y: 20,
        height: 0,
        neighbor: () => null,
        time,
        wind,
      });
    expect(at(0, 0)).toBe(grassGlyphs[grassVariant(10, 20, 0, 0)]);
  });
});

describe('the wind front and its wake', () => {
  const field = cells(200_000, 300_000, 64);

  it('has a gust that is exactly the wind gust, and a wake that stays in 0–1', () => {
    for (const [x, y] of field) {
      for (const t of [3, 12.5, 40]) {
        const { gust, wake } = windFront(x, y, t);
        expect(gust).toBe(windGust(x, y, t));
        expect(wake).toBeGreaterThanOrEqual(0);
        expect(wake).toBeLessThanOrEqual(1);
        // The wake starts where the crest ends: never both at their fullest.
        expect(gust + wake).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });

  it('follows a crest: calm air before it, a wake behind it, in the moments after', () => {
    let behind = 0;
    let ahead = 0;
    let total = 0;
    for (const [x, y] of field) {
      if (windGust(x, y, 20) < 0.9) continue;
      total++;
      // A second later the front has moved on downwind: this cell is in its wake.
      if (windFront(x, y, 21).wake > 0) behind++;
      // A second earlier the front hadn't arrived: no wake yet.
      if (windFront(x, y, 19).wake === 0) ahead++;
    }
    expect(total).toBeGreaterThan(0);
    expect(behind / total).toBeGreaterThan(0.8);
    expect(ahead / total).toBeGreaterThan(0.8);
  });

  it('leaves most of the map in neither, so the patch noise is skipped', () => {
    const still = field.filter(([x, y]) => {
      const { gust, wake } = windFront(x, y, 20);
      return gust === 0 && wake === 0;
    });
    expect(still.length).toBeGreaterThan(field.length / 2);
  });
});

describe('clumped canopy', () => {
  const field = cells(500_000, 800_000, 64);

  it('has one crown center per block, and foliage around it', () => {
    const variants = field.map(([x, y]) => canopyVariant(x, y));
    const centers = variants.filter((v) => v < 3).length;
    expect(centers).toBeGreaterThan((field.length / (CANOPY.cols * CANOPY.rows)) * 0.8);
    expect(centers).toBeLessThan((field.length / (CANOPY.cols * CANOPY.rows)) * 1.2);
    const foliage = variants.filter((v) => v === CanopyGlyph.foliage).length;
    expect(foliage).toBeGreaterThan(field.length / 2);
  });

  it('leaves a few clearings, but keeps the canopy mostly closed', () => {
    const gaps = field.filter(([x, y]) => canopyVariant(x, y) === CanopyGlyph.gap).length;
    expect(gaps).toBeGreaterThan(0);
    expect(gaps).toBeLessThan(field.length * 0.2);
  });

  it('draws palms and conifers at the centers of their woods', () => {
    const centers = field.filter(([x, y]) => canopyVariant(x, y) < 3);
    for (const [x, y] of centers) {
      expect(canopyVariant(x, y, 1)).toBe(CanopyGlyph.palm);
      expect([CanopyGlyph.needle, CanopyGlyph.needle + 1]).toContain(canopyVariant(x, y, 2));
      expect(canopyVariant(x, y, 3)).toBe(canopyVariant(x, y));
    }
  });

  it('stays put: the same cell always gets the same glyph', () => {
    for (const [x, y] of field.slice(0, 50)) expect(canopyVariant(x, y)).toBe(canopyVariant(x, y));
  });
});

describe('trees in the wind', () => {
  const field = cells(700_000, 900_000, 64);

  it('catch a gust a moment after the grass under them, and only a stronger one', () => {
    for (const [x, y] of field.slice(0, 200)) {
      expect(treeGust(x, y, 30)).toBe(windGust(x, y, 30 - TREE_WIND.lag));
    }
    expect(TREE_WIND.step).toBeGreaterThan(GUST_STEPS[0]);
  });

  it('swing their branches downwind, the tips most, and never at the trunk or in still air', () => {
    const [dx, dy] = DEFAULT_WIND_DIR;
    expect(Math.hypot(dx, dy)).toBeCloseTo(1);
    for (const v of [...swayOffset(0, 1, 0, 3, 0.5), ...swayOffset(5, 0, 0, 3, 0.5)])
      expect(v).toBeCloseTo(0);
    // Downwind on average (the flutter across it averages out over a cycle).
    const mean = [0, 0];
    for (let i = 0; i < 100; i++) {
      const [x, y] = swayOffset(4, 1, 0, (i / 100) * ((2 * Math.PI) / SWAY.rate), 0);
      mean[0]! += x / 100;
      mean[1]! += y / 100;
    }
    expect(mean[0]! * dx + mean[1]! * dy).toBeCloseTo(SWAY.bend * 4, 1);
    // Farther from the trunk swings more, up to the cap.
    const along = (reach: number) => {
      const [x, y] = swayOffset(reach, 1, 0, 0, 0);
      return x * dx + y * dy;
    };
    expect(along(2)).toBeLessThan(along(4));
    expect(along(100)).toBeCloseTo(SWAY.max);
  });

  it('spring back upwind in the wake behind a gust, and settle', () => {
    const [dx, dy] = DEFAULT_WIND_DIR;
    for (let i = 0; i < 40; i++) {
      // No gust, only its wake: the crown is upwind of rest whatever the moment of its rocking.
      const [x, y] = swayOffset(4, 0, 1, i * 0.37, i);
      expect(x * dx + y * dy).toBeLessThan(0);
    }
    // The recoil is smaller than the push, and the wake alone never throws a crown far.
    const push = swayOffset(4, 1, 0, 0, 0);
    const back = swayOffset(4, 0, 1, 0, 0);
    expect(Math.hypot(...back)).toBeLessThan(Math.hypot(...push));
    expect(SWAY.recoil).toBeLessThan(1);
  });

  it('flutter their leaves between % and & in a gust, and hold still without wind', () => {
    for (const [x, y] of field) {
      expect(foliageVariant(x, y, 20, 0)).toBe(foliageVariant(x, y, 21, 0));
      expect([0, 1]).toContain(foliageVariant(x, y, 20, 1));
    }
    const flips = field.filter(
      ([x, y]) => foliageVariant(x, y, 20, 1) !== foliageVariant(x, y, 20.4, 1),
    );
    expect(flips.length).toBeGreaterThan(field.length / 8);
    const crown = (time: number, wind: number) =>
      field.map(([x, y]) =>
        selectGlyph(themes.dark, 'tree_crown', {
          x,
          y,
          height: 0,
          neighbor: () => null,
          time,
          wind,
        }),
      );
    for (const glyph of crown(20, 1)) expect(['%', '&']).toContain(glyph);
    expect(crown(20, 0)).toEqual(crown(25, 0));
  });

  it('draw a crown as a rim of leaves around an inside, with a dense core here and there', () => {
    const rim = field.map(([x, y]) => foliageVariant(x, y, 0, 0, true));
    expect(new Set(rim)).toEqual(new Set([CrownGlyph.rim]));
    const inside = field.map(([x, y]) => foliageVariant(x, y, 0, 0, false));
    expect(new Set(inside)).toEqual(new Set([CrownGlyph.interior, CrownGlyph.core]));
    const cores = inside.filter((v) => v === CrownGlyph.core).length / field.length;
    // About a quarter of the inside.
    expect(cores).toBeGreaterThan(0.15);
    expect(cores).toBeLessThan(0.35);
    // In a gust the leaves flutter whatever their place in the crown.
    for (const [x, y] of field.slice(0, 200)) {
      expect([0, 1]).toContain(foliageVariant(x, y, 20, 1, false));
    }
  });

  it('draw a crown from the rim of its neighbors', () => {
    const glyph = (neighbor: () => 'tree_crown' | 'grass' | null, x: number, y: number) =>
      selectGlyph(themes.dark, 'tree_crown', { x, y, height: 0, neighbor, time: 0, wind: 0 });
    for (const [x, y] of field.slice(0, 100)) {
      expect(glyph(() => 'grass', x, y)).toBe('%'); // rim: something else all around
      expect(['&', '@']).toContain(glyph(() => 'tree_crown', x, y)); // inside
    }
  });

  it('yellow one crown in a few', () => {
    const dry = Array.from({ length: 2000 }, (_, id) => id).filter(crownIsDry).length / 2000;
    expect(dry).toBeGreaterThan(0.5 / CROWN.dryEvery);
    expect(dry).toBeLessThan(1.6 / CROWN.dryEvery);
  });

  it('lean the woods downwind in a gust, and flutter their foliage', () => {
    expect(canopyLean(0)).toBe(0);
    expect(canopyLean(1)).toBeCloseTo(CANOPY.sway);
    const east = windFrom(270);
    // A lean of a whole number of cells moves the crowns exactly that far. (Rustling leaves and
    // the clearing's gap dots, which stay on their cells, are foliage here.)
    const shape = (v: number) =>
      v === CanopyGlyph.rustle || v === CanopyGlyph.gap ? CanopyGlyph.foliage : v;
    const gust = 3 / CANOPY.sway;
    for (const [x, y] of field) {
      expect(canopyVariant(x, y, 0, 0, 5)).toBe(canopyVariant(x, y, 0, 0, 9));
      expect(shape(canopyVariant(x + 3, y, 0, gust, 5, east))).toBe(shape(canopyVariant(x, y)));
      expect([CanopyGlyph.foliage, CanopyGlyph.rustle, CanopyGlyph.gap, 0, 1, 2]).toContain(
        canopyVariant(x, y, 0, 1, 5),
      );
    }
  });

  it('let the woods creep, not jump: a slightly stronger gust changes few cells', () => {
    const still = (v: number) => (v === CanopyGlyph.rustle ? CanopyGlyph.foliage : v);
    const changed = field.filter(
      ([x, y]) => still(canopyVariant(x, y, 0, 1.0, 5)) !== still(canopyVariant(x, y, 0, 1.1, 5)),
    );
    expect(changed.length).toBeLessThan(field.length * 0.25);
  });

  it('light the sunny side of a wood and shade the far side, and swap them with the sun', () => {
    const sun = DEFAULT_SUN;
    const away: readonly [number, number] = [-sun[0], -sun[1]];
    let lit = 0;
    let shaded = 0;
    for (const [x, y] of field) {
      const a = canopyCell(x, y, 0, 0, 0, DEFAULT_WIND_DIR, sun);
      const b = canopyCell(x, y, 0, 0, 0, DEFAULT_WIND_DIR, away);
      expect(b.variant).toBe(a.variant);
      if (a.variant !== CanopyGlyph.foliage) {
        expect(a.tone).toBe(Tone.none); // centers and clearings keep their own color
        continue;
      }
      if (a.tone === Tone.light) {
        lit++;
        expect(b.tone).toBe(Tone.shade);
      } else if (a.tone === Tone.shade) {
        shaded++;
        expect(b.tone).toBe(Tone.light);
      }
    }
    expect(lit).toBeGreaterThan(field.length / 20);
    expect(shaded).toBeGreaterThan(field.length / 20);
  });
});

describe('wind levels and tones', () => {
  it('rise with the gust: still, stirring, leaning, flat', () => {
    expect(windLevel(0)).toBe(0);
    expect(windLevel(STIR.gust - 0.01)).toBe(0);
    expect(windLevel(STIR.gust)).toBe(1);
    expect(windLevel(0, STIR.wake)).toBe(1); // settling in a gust's wake
    expect(windLevel(0, STIR.wake - 0.01)).toBe(0);
    expect(windLevel(GUST_STEPS[0])).toBe(2);
    expect(windLevel(GUST_STEPS[1])).toBe(3);
    let last = 0;
    for (let g = 0; g <= 1.5; g += 0.01) {
      const level = windLevel(g);
      expect(level).toBeGreaterThanOrEqual(last);
      last = level;
    }
    for (let i = 1; i < WIND_LIGHT.length; i++) {
      expect(WIND_LIGHT[i]!).toBeGreaterThan(WIND_LIGHT[i - 1]!);
    }
  });

  it('tint dark, light, and straw, relative to the color they tint', () => {
    for (const rgb of [
      [0.55, 0.75, 0.37],
      [0.24, 0.54, 0.23],
    ] as const) {
      const [r, g, b] = rgb;
      expect(toneColor(rgb, Tone.none)).toEqual([r, g, b]);
      const shade = toneColor(rgb, Tone.shade);
      const light = toneColor(rgb, Tone.light);
      const dry = toneColor(rgb, Tone.dry);
      expect(shade[1]).toBeCloseTo(g * TONE.shade);
      expect(light[1]).toBeGreaterThan(g);
      expect(light[1]).toBeLessThan(1);
      // Straw: redder and less blue than the green it was.
      expect(dry[0]).toBeGreaterThan(r);
      expect(dry[2]).toBeLessThan(b);
    }
  });

  it('keeps grass tones to its patches: dry and deep green, some in specks', () => {
    const field = cells(400_000, 600_000, 96);
    let dry = 0;
    let shade = 0;
    let specks = 0;
    for (const [x, y] of field) {
      const lush = valueNoise(x, y, GRASS.lushScale, GRASS.lushSeed);
      const { tone } = grassCell(x, y, 0);
      if (lush < GRASS.dryBelow) expect(tone).toBe(Tone.dry);
      else if (tone === Tone.dry) {
        // Outside a dry patch, only in the speckled margin.
        expect(lush).toBeLessThan(GRASS.speckBelow);
        specks++;
      } else if (lush > GRASS.shadeAbove) expect(tone).toBe(Tone.shade);
      else expect(tone).toBe(Tone.none);
      if (tone === Tone.dry) dry++;
      if (tone === Tone.shade) shade++;
      // The tone doesn't change with the wind.
      expect(grassCell(x, y, 0.5).tone).toBe(tone);
    }
    expect(dry).toBeGreaterThan(field.length * 0.03);
    expect(dry).toBeLessThan(field.length * 0.4);
    expect(shade).toBeGreaterThan(field.length * 0.03);
    expect(specks).toBeGreaterThan(0);
  });

  it('ripens patches of a field', () => {
    const field = cells(300_000, 500_000, 96);
    const ripe = field.filter(([x, y]) => cropTone(x, y) === Tone.dry);
    for (const [x, y] of ripe) {
      expect(valueNoise(x, y, CROP.ripeScale, CROP.ripeSeed)).toBeGreaterThan(CROP.ripeAbove);
    }
    expect(ripe.length).toBeGreaterThan(field.length * 0.03);
    expect(ripe.length).toBeLessThan(field.length * 0.5);
  });
});

describe('trees', () => {
  it('draws a tree by its kind (tree variant byte)', () => {
    const glyph = (variant: number) =>
      selectGlyph(themes.dark, 'tree', {
        x: 0,
        y: 0,
        height: 0,
        neighbor: () => null,
        time: 0,
        variant,
      });
    expect([glyph(0), glyph(1), glyph(2), glyph(3)]).toEqual(['♣', 'Ψ', '↑', '♣']);
  });

  it('draws grass and crowns with sub-cell edges, whatever their id', () => {
    expect(subcellClasses).toContain('grass');
    expect(subcellClasses).toContain('tree_crown');
    const areas = subcellAreas();
    expect(areas).toHaveLength(MAX_CLASSES);
    expect(areas[classId('tree_crown')]).toBe(1);
    expect(classId('tree_crown')).toBeGreaterThan(31);
    expect(areas[classId('road_major')]).toBe(0);
  });
});

describe('fields and water in the wind', () => {
  const field = cells(300_000, 500_000, 48);

  it('keeps the rows still without a gust', () => {
    for (const [, y] of field) {
      expect(cropVariant(y, 0)).toBe(((y % 2) + 2) % 2);
      expect(cropVariant(y, GUST_STEPS[0] - 0.01)).toBe(((y % 2) + 2) % 2);
    }
  });

  it('leans the crop rows downwind and ripples the furrows in a gust', () => {
    const east = windFrom(270);
    const west = windFrom(90);
    expect(cropVariant(1, GUST_STEPS[0], east)).toBe(CropGlyph.leanRight);
    expect(cropVariant(1, GUST_STEPS[0], west)).toBe(CropGlyph.leanLeft);
    expect(cropVariant(0, GUST_STEPS[0], east)).toBe(CropGlyph.flat);
    expect(cropVariant(1, GUST_STEPS[1], east)).toBe(CropGlyph.flat);
  });

  it('ruffles water in the gust bands, and lets it flip on its own elsewhere', () => {
    for (const [x, y] of field.slice(0, 100)) {
      expect(waterVariant(x, y, 12, 0)).toBe(waterVariant(x, y, 12));
      expect(waterVariant(x, y, 12, GUST_STEPS[1])).toBe(0);
      expect(waterVariant(x, y, 12, GUST_STEPS[0])).toBe(1);
    }
  });

  it('draws farmland as a crop in the wind', () => {
    const tables = buildGlyphTables(themes.dark, (g) => g.codePointAt(0)! % 256);
    expect(tables.kinds[classId('farmland')]).toBe(kindCodes.crop);
    expect(themes.dark.styles.farmland!.glyphs).toEqual(['≡', "'", '/', '\\', '~']);
  });
});
