/**
 * Wind over grass and trees, and clumped canopy, in GLSL: the twins of `valueNoise`,
 * `windGust`, `treeGust`, `swayOffset`, `grassVariant`, `foliageVariant`, and `canopyVariant`
 * in glyphs/select.ts (unit-tested there). The variants take the gust already scaled by the
 * wind, which blows along the u_windDir uniform declared here. Needs `cellHashGlsl` before it.
 */
import {
  CANOPY,
  CanopyGlyph,
  CropGlyph,
  FLUTTER,
  GrassGlyph,
  GUST_STEPS,
  SWAY,
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

float windGust(ivec2 c, float time) {
  vec2 wrapped = vec2(vmod(c.x, ${WIND.wrap}), vmod(c.y, ${WIND.wrap}));
  float along = dot(wrapped, u_windDir) / ${float(WIND.period)};
  float travel = time * ${float(WIND.speed)} / ${float(WIND.period)};
  float s = along - fract(travel) + ${float(WIND.bend)} * valueNoise(c, ${WIND.bendScale}, 0);
  float band = smoothstep(0.7, 1.0, 0.5 + 0.5 * sin(${2 * Math.PI} * s));
  float k = time * ${float(WIND.drift)};
  int k0 = int(floor(k));
  float kf = smoothstep(0.0, 1.0, k - float(k0));
  float a = valueNoise(c, ${WIND.patchScale}, 1 + k0);
  float b = valueNoise(c, ${WIND.patchScale}, 2 + k0);
  return band * smoothstep(0.35, 0.65, mix(a, b, kf));
}

float treeGust(ivec2 c, float time) {
  return windGust(c, time - ${float(TREE_WIND.lag)});
}

int grassVariant(ivec2 c, float gust) {
  if (gust < ${float(GUST_STEPS[0])}) return vmod(c.x + c.y, 3);
  if (gust < ${float(GUST_STEPS[1])}) return u_windDir.x >= 0.0 ? ${GrassGlyph.leanRight} : ${GrassGlyph.leanLeft};
  return ${GrassGlyph.flat};
}

int cropVariant(ivec2 c, float gust) {
  int row = vmod(c.y, 2);
  if (gust < ${float(GUST_STEPS[0])}) return row;
  if (row == 0 || gust >= ${float(GUST_STEPS[1])}) return ${CropGlyph.flat};
  return u_windDir.x >= 0.0 ? ${CropGlyph.leanRight} : ${CropGlyph.leanLeft};
}

// Cells a crown vertex reach cells from its trunk swings in a gust (glyphs/select.ts swayOffset).
vec2 swayOffset(float reach, float gust, float time, float phase) {
  vec2 dir = u_windDir;
  float along = gust * min(${float(SWAY.bend)} * reach, ${float(SWAY.max)});
  float across = gust * ${float(SWAY.flutter)} * min(reach / 2.0, 1.0) * sin(time * ${float(SWAY.rate)} + phase);
  return dir * along + vec2(-dir.y, dir.x) * across;
}

bool flutters(uint h, float gust, float time) {
  float phase = float((h >> 8u) & 255u) / 256.0;
  int flips = int(floor(time * ${float(FLUTTER.rate)} * (0.5 + gust) + phase));
  return ((int(h >> 2u) + flips) & 1) == 1;
}

int foliageVariant(ivec2 c, float time, float gust) {
  uint h = cellHash(c);
  if (gust >= ${float(TREE_WIND.step)}) return flutters(h, gust, time) ? 0 : 1;
  return int(h % 4u);
}

int canopyShape(ivec2 c, int variant) {
  int gx = floorDiv(c.x, ${CANOPY.cols});
  int gy = floorDiv(c.y, ${CANOPY.rows});
  float bestD = 1e9;
  uint bestHash = 0u;
  for (int oy = -1; oy <= 1; oy++) {
    for (int ox = -1; ox <= 1; ox++) {
      uint h = cellHash(ivec2(gx + ox, gy + oy));
      int cx = (gx + ox) * ${CANOPY.cols} + int(h % ${CANOPY.cols}u);
      int cy = (gy + oy) * ${CANOPY.rows} + int((h >> 8u) % ${CANOPY.rows}u);
      vec2 d = vec2(c.x - cx, c.y - cy) / vec2(${float(CANOPY.cols)}, ${float(CANOPY.rows)});
      float dd = dot(d, d);
      if (dd < bestD) {
        bestD = dd;
        bestHash = h;
      }
    }
  }
  if (bestD == 0.0) {
    if (variant == 1) return ${CanopyGlyph.palm};
    if (variant == 2) return ${CanopyGlyph.needle} + int((bestHash >> 16u) & 1u);
    return int((bestHash >> 16u) % 3u);
  }
  bool clearing = bestD > ${float(CANOPY.clearing * CANOPY.clearing)};
  if (clearing && ((cellHash(c) >> 8u) & 255u) < ${Math.round(CANOPY.gaps * 256)}u) return ${CanopyGlyph.gap};
  return ${CanopyGlyph.foliage};
}

int canopyVariant(ivec2 c, int variant, float gust, float time) {
  int shift = gust >= ${float(TREE_WIND.step)} ? int(floor(gust * ${float(CANOPY.sway)} + 0.5)) : 0;
  int v = canopyShape(c - ivec2(floor(u_windDir * float(shift) + 0.5)), variant);
  if (v == ${CanopyGlyph.foliage} && gust >= ${float(TREE_WIND.step)} && flutters(cellHash(c), gust, time)) {
    return ${CanopyGlyph.rustle};
  }
  return v;
}
`;
