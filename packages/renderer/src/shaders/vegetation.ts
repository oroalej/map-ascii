/**
 * Wind over grass and trees, and clumped canopy, in GLSL: the twins of `valueNoise`,
 * `windFront`, `treeFront`, `swayOffset`, `grassCell`, `foliageVariant`, and `canopyCell` in
 * glyphs/select.ts (unit-tested there). The variants take the gust (and wake) already scaled by
 * the wind, which blows along the u_windDir uniform declared here. Needs `cellHashGlsl` before it.
 */
import {
  CANOPY,
  CanopyGlyph,
  CROP,
  CropGlyph,
  CROWN,
  CrownGlyph,
  FLUTTER,
  GrassGlyph,
  GRASS,
  PLANTING,
  GUST_STEPS,
  STIR,
  SWAY,
  Tone,
  TREE_WIND,
  WIND,
} from '../glyphs/select';

const float = (n: number) => (Number.isInteger(n) ? `${n}.0` : `${n}`);

export const vegetationGlsl = /* glsl */ `
uniform vec2 u_windDir; // where the wind blows: a unit vector in cells (x east, y south)

int vmod(int a, int n) {
  return ((a % n) + n) % n;
}

int floorDiv(int a, int n) {
  return (a - vmod(a, n)) / n;
}

float latticeValue(int x, int y, int seed) {
  return float(cellHash(ivec2(x + seed * 7919, y - seed * 104729)) >> 8u) / 16777216.0;
}

float valueNoise(ivec2 c, int scale, int seed) {
  int ix = floorDiv(c.x, scale);
  int iy = floorDiv(c.y, scale);
  vec2 f = vec2(vmod(c.x, scale), vmod(c.y, scale)) / float(scale);
  vec2 s = f * f * (3.0 - 2.0 * f);
  float top = mix(latticeValue(ix, iy, seed), latticeValue(ix + 1, iy, seed), s.x);
  float bottom = mix(latticeValue(ix, iy + 1, seed), latticeValue(ix + 1, iy + 1, seed), s.x);
  return mix(top, bottom, s.y);
}

// x: the gust, y: the wake behind its crest. Most cells are in neither, and skip the patch noise.
vec2 windFront(ivec2 c, float time) {
  vec2 wrapped = vec2(vmod(c.x, ${WIND.wrap}), vmod(c.y, ${WIND.wrap}));
  float along = dot(wrapped, u_windDir) / ${float(WIND.period)};
  float travel = time * ${float(WIND.speed)} / ${float(WIND.period)};
  float s = along - fract(travel) + ${float(WIND.bend)} * valueNoise(c, ${WIND.bendScale}, 0);
  float phase = ${2 * Math.PI} * s;
  float v = 0.5 + 0.5 * sin(phase);
  float band = smoothstep(0.7, 1.0, v);
  float behind = cos(phase) > 0.0 ? smoothstep(0.2, 0.7, v) * (1.0 - band) : 0.0;
  if (band <= 0.0 && behind <= 0.0) return vec2(0.0);
  float k = time * ${float(WIND.drift)};
  int k0 = int(floor(k));
  float kf = smoothstep(0.0, 1.0, k - float(k0));
  float a = valueNoise(c, ${WIND.patchScale}, 1 + k0);
  float b = valueNoise(c, ${WIND.patchScale}, 2 + k0);
  float gustPatch = smoothstep(0.35, 0.65, mix(a, b, kf));
  return vec2(band, behind) * gustPatch;
}

float windGust(ivec2 c, float time) {
  return windFront(c, time).x;
}

vec2 treeFront(ivec2 c, float time) {
  return windFront(c, time - ${float(TREE_WIND.lag)});
}

float treeGust(ivec2 c, float time) {
  return treeFront(c, time).x;
}

// 0 still, 1 stirring or settling, 2 leaning, 3 flat (glyphs/select.ts windLevel).
int windLevel(float gust, float wake) {
  if (gust >= ${float(GUST_STEPS[1])}) return 3;
  if (gust >= ${float(GUST_STEPS[0])}) return 2;
  return (gust >= ${float(STIR.gust)} || wake >= ${float(STIR.wake)}) ? 1 : 0;
}

// A grass cell's glyph, and its tone (glyphs/select.ts grassCell).
int grassVariant(ivec2 c, float gust, out int tone) {
  float lush = valueNoise(c, ${GRASS.lushScale}, ${GRASS.lushSeed});
  uint h = cellHash(c);
  tone = (lush < ${float(GRASS.dryBelow)}
      || (lush < ${float(GRASS.speckBelow)} && float((h >> 16u) & 255u) < ${float(GRASS.speck * 256)}))
    ? ${Tone.dry} : lush > ${float(GRASS.shadeAbove)} ? ${Tone.shade} : ${Tone.none};
  if (gust >= ${float(GUST_STEPS[1])}) return ${GrassGlyph.flat};
  if (gust >= ${float(GUST_STEPS[0])}) {
    if (abs(u_windDir.x) < ${float(GRASS.uprightBelow)}) return ${GrassGlyph.upright};
    return u_windDir.x > 0.0 ? ${GrassGlyph.leanRight} : ${GrassGlyph.leanLeft};
  }
  float score = lush + (float((h >> 8u) & 255u) / 256.0 - 0.5) * ${float(GRASS.jitter)};
  return score > ${float(GRASS.dense)} ? 0
    : score > ${float(GRASS.medium)} ? 1
    : score > ${float(GRASS.thin)} ? 2 : ${GrassGlyph.sparse};
}

int plantingVariant(ivec2 c, float gust, out int tone) {
  if (valueNoise(c, ${PLANTING.scale}, ${PLANTING.seed}) < ${float(PLANTING.bareBelow)}) {
    tone = ${Tone.none};
    return ${PLANTING.bareGlyph};
  }
  return grassVariant(c, gust, tone);
}

int cropVariant(ivec2 c, float gust) {
  int row = vmod(c.y, 2);
  if (gust < ${float(GUST_STEPS[0])}) return row;
  if (row == 0 || gust >= ${float(GUST_STEPS[1])}) return ${CropGlyph.flat};
  return u_windDir.x >= 0.0 ? ${CropGlyph.leanRight} : ${CropGlyph.leanLeft};
}

// Broad patches of a field ripen (glyphs/select.ts cropTone).
int cropTone(ivec2 c) {
  return valueNoise(c, ${CROP.ripeScale}, ${CROP.ripeSeed}) > ${float(CROP.ripeAbove)}
    ? ${Tone.dry} : ${Tone.none};
}

// Cells a crown vertex reach cells from its trunk swings in a gust, and springs back in the wake
// behind it (glyphs/select.ts swayOffset).
vec2 swayOffset(float reach, float gust, float wake, float time, float phase) {
  vec2 dir = u_windDir;
  float lean = gust - ${float(SWAY.recoil)} * wake * (0.6 + 0.4 * cos(time * ${float(SWAY.bounce)} + phase));
  float along = lean * min(${float(SWAY.bend)} * reach, ${float(SWAY.max)});
  float across = (gust + 0.6 * wake) * ${float(SWAY.flutter)} * min(reach / 2.0, 1.0)
    * sin(time * ${float(SWAY.rate)} + phase);
  return dir * along + vec2(-dir.y, dir.x) * across;
}

bool flutters(uint h, float gust, float time) {
  float phase = float((h >> 8u) & 255u) / 256.0;
  int flips = int(floor(time * ${float(FLUTTER.rate)} * (0.5 + gust) + phase));
  return ((int(h >> 2u) + flips) & 1) == 1;
}

// A crown's glyph: the rim, an interior, or a dense core; fluttering in a gust (glyphs/select.ts).
int foliageVariant(ivec2 c, float time, float gust, bool rim) {
  uint h = cellHash(c);
  if (gust >= ${float(TREE_WIND.step)}) return flutters(h, gust, time) ? 0 : 1;
  if (rim) return ${CrownGlyph.rim};
  return valueNoise(c, ${CROWN.core.scale}, ${CROWN.core.seed}) > ${float(CROWN.core.above)}
    && h % ${CROWN.core.skip}u != 0u ? ${CrownGlyph.core} : ${CrownGlyph.interior};
}

// Whether the crown of feature id is yellowing.
bool crownIsDry(uint id) {
  return cellHash(ivec2(int(id), 5)) % ${CROWN.dryEvery}u == 0u;
}

// The woods' pattern read from upwind by lean cells (fractional, so its edges creep): split into a
// whole shift and a fraction to stay exact at large world coordinates (glyphs/select.ts).
int canopyShape(ivec2 c, int variant, vec2 lean, vec2 sun, out int tone) {
  tone = ${Tone.none};
  vec2 shift = floor(lean);
  ivec2 ci = c - ivec2(shift);
  vec2 f = lean - shift;
  int gx = floorDiv(ci.x - (f.x > 0.0 ? 1 : 0), ${CANOPY.cols});
  int gy = floorDiv(ci.y - (f.y > 0.0 ? 1 : 0), ${CANOPY.rows});
  float bestD = 1e9;
  uint bestHash = 0u;
  vec2 best = vec2(0.0);
  for (int oy = -1; oy <= 1; oy++) {
    for (int ox = -1; ox <= 1; ox++) {
      uint h = cellHash(ivec2(gx + ox, gy + oy));
      int cx = (gx + ox) * ${CANOPY.cols} + int(h % ${CANOPY.cols}u);
      int cy = (gy + oy) * ${CANOPY.rows} + int((h >> 8u) % ${CANOPY.rows}u);
      vec2 d = vec2(float(ci.x - cx), float(ci.y - cy)) - f;
      vec2 n = d / vec2(${float(CANOPY.cols)}, ${float(CANOPY.rows)});
      float dd = dot(n, n);
      if (dd < bestD) {
        bestD = dd;
        bestHash = h;
        best = d;
      }
    }
  }
  if (abs(best.x) < 0.5 && abs(best.y) < 0.5) {
    if (variant == 1) return ${CanopyGlyph.palm};
    if (variant == 2) return ${CanopyGlyph.needle} + int((bestHash >> 16u) & 1u);
    return int((bestHash >> 16u) % 3u);
  }
  bool clearing = bestD > ${float(CANOPY.clearing * CANOPY.clearing)};
  if (clearing && ((cellHash(c) >> 8u) & 255u) < ${Math.round(CANOPY.gaps * 256)}u) return ${CanopyGlyph.gap};
  float toSun = dot(best, sun);
  tone = toSun > ${float(CANOPY.lit)} ? ${Tone.light} : toSun < ${float(-CANOPY.lit)} ? ${Tone.shade} : ${Tone.none};
  return ${CanopyGlyph.foliage};
}

int canopyVariant(ivec2 c, int variant, float gust, float time, vec2 sun, out int tone) {
  int v = canopyShape(c, variant, u_windDir * (gust * ${float(CANOPY.sway)}), sun, tone);
  if (v == ${CanopyGlyph.foliage} && gust >= ${float(TREE_WIND.step)} && flutters(cellHash(c), gust, time)) {
    return ${CanopyGlyph.rustle};
  }
  return v;
}
`;
