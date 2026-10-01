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

import { foliageGlsl } from './foliage';

const float = (n: number) => (Number.isInteger(n) ? `${n}.0` : `${n}`);

export const windVegetationGlsl = /* glsl */ `
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

`;

/** Leaf selection is isolated from the core selection program to bound driver compilation. */
export const vegetationGlsl = /* glsl */ `${windVegetationGlsl}
${foliageGlsl}
uniform ivec2 u_canopyOrigin;
uniform vec2 u_canopyPhase;
uniform vec2 u_canopyStep;

bool flutters(uint h, float gust, float time) {
  float phase = float((h >> 8u) & 255u) / 256.0;
  int flips = int(floor(time * ${float(FLUTTER.rate)} * (0.5 + gust) + phase));
  return ((int(h >> 2u) + flips) & 1) == 1;
}

int foliageVariant(ivec2 c, vec2 local, uint seed, float time, float gust, bool rim, bool boundary) {
  vec4 clumps=crownClumps(local,seed);
  int level=crownLevel(crownShade(local,clumps),clumps.y,length(local));
  if(gust>=${float(TREE_WIND.step)}) level=clamp(level+(flutters(cellHash(c),gust,time)?1:-1),0,5);
  if(clumps.y>0.6 || boundary) level=min(level,1);
  if(rim || length(local)>0.75) level=min(level,2);
  return level;
}

// Whether the crown of feature id is yellowing.
bool crownIsDry(uint id) {
  return cellHash(ivec2(int(id), 5)) % ${CROWN.dryEvery}u == 0u;
}

// Fixed projected lattice. The integer block origin is never converted to a large float.
int canopyVariant(ivec2 p, ivec2 w, int variant, float gust, float time, out int tone) {
  vec2 pos=u_canopyPhase+(vec2(p)-u_windDir*(gust*${float(CANOPY.sway)}))*u_canopyStep;
  ivec2 g=ivec2(floor(pos));
  vec2 frac=fract(pos);
  float f1=1e9,f2=1e9;
  uint seed=0u;
  vec2 best=vec2(0);
  for(int oy=-1;oy<=1;oy++) for(int ox=-1;ox<=1;ox++) {
    uint h=cellHash(u_canopyOrigin+g+ivec2(ox,oy));
    vec2 d=frac-vec2(ox,oy)-vec2(0.15)-vec2(hashByte(h,0u),hashByte(h,8u))*0.7;
    float dd=dot(d,d);
    if(dd<f1) { f2=f1; f1=dd; seed=h; best=d; } else if(dd<f2) f2=dd;
  }
  tone=${Tone.none};
  if(all(lessThan(abs(best),u_canopyStep*0.5))) {
    if(variant==1) return ${CanopyGlyph.palm};
    if(variant==2) return ${CanopyGlyph.needle}+int((seed>>16u)&1u);
  }
  if(f1>${float(CANOPY.clearing * CANOPY.clearing)} && ((cellHash(w)>>8u)&255u)<${Math.round(CANOPY.gaps * 256)}u) { tone=${Tone.shade}; return 0; }
  vec2 local=best/${float(CANOPY.radius)};
  vec4 clumps=crownClumps(local,seed);
  clumps.y=max(clumps.y,1.0-smoothstep(0.0,${float(CANOPY.crease)},sqrt(f2)-sqrt(f1)));
  int level=crownLevel(crownShade(local,clumps),clumps.y,length(local));
  if(gust>=${float(TREE_WIND.step)}) level=clamp(level+(flutters(cellHash(w),gust,time)?1:-1),0,5);
  if(clumps.y>0.6) level=min(level,1);
  if(length(local)>0.75) level=min(level,2);
  tone=level<=1 ? ${Tone.shade} : level>=4 ? ${Tone.light} : seed%${CANOPY.freshEvery}u==0u ? ${Tone.dry} : ${Tone.none};
  return level;
}
`;
