/** Leaf glyphs and tones, isolated from walls/roads/shadow tracing to bound shader complexity. */
import { MAX_CLASSES } from '../classes';
import { EDGE_STATE, kindCodes, Tone, TONE_SHIFT } from '../glyphs/select';
import { cellHashGlsl } from './hash';
import { vegetationGlsl } from './vegetation';

/** Internal intermediate-alpha bit; the final background class still occupies only six bits. */
export const FOLIAGE_PENDING = 1 << 6;

export const foliageSelectFragment = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D u_inputGlyphs;
uniform sampler2D u_class;
uniform sampler2D u_attr;
uniform sampler2D u_id;
uniform sampler2D u_table;
uniform int u_kind[${MAX_CLASSES}];
uniform int u_count[${MAX_CLASSES}];
uniform ivec2 u_origin;
uniform float u_time;
uniform float u_wind;
layout(location=0) out vec4 o_glyph;
layout(location=1) out vec4 o_foliageLight;

${cellHashGlsl}
${vegetationGlsl}

int classAt(ivec2 p) {
  p = clamp(p, ivec2(0), textureSize(u_class, 0) - 1);
  return int(texelFetch(u_class, p, 0).r * 255.0 + 0.5);
}
vec4 idAt(ivec2 p) {
  p = clamp(p, ivec2(0), textureSize(u_id, 0) - 1);
  return texelFetch(u_id, p, 0);
}
uint unpackId(vec4 id) {
  uvec4 b = uvec4(id * 255.0 + 0.5);
  return b.r | (b.g << 8u) | (b.b << 16u) | (b.a << 24u);
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 selected = texelFetch(u_inputGlyphs, p, 0);
  int cls = int(selected.g * 255.0 + 0.5) & 63;
  int state = int(selected.b * 255.0 + 0.5);
  int kind = u_kind[cls];
  o_glyph = selected;
  o_foliageLight = vec4(0.0);
  int background = int(selected.a * 255.0 + 0.5);
  if ((background & ${FOLIAGE_PENDING}) == 0) return;
  o_glyph.a = float(background & 63) / 255.0;
  // Preserve all sextants and non-foliage metadata exactly, including high glyph bits.
  if ((state & ${EDGE_STATE}) != 0 ||
      (kind != ${kindCodes.foliage} && kind != ${kindCodes.canopy})) return;

  ivec2 w = u_origin + p;
  vec4 attr = texelFetch(u_attr, p, 0);
  float gust = u_wind > 0.0 ? u_wind * treeGust(w, u_time) : 0.0;
  int tone;
  int variant;
  float leafLight;
  if (kind == ${kindCodes.canopy}) {
    variant = canopyVariant(p, w, int(attr.b * 255.0 + 0.5), gust, u_time, tone, leafLight);
  } else {
    vec4 id = idAt(p);
    bool rim = false;
    bool boundary = false;
    const ivec2 sides[4] = ivec2[4](ivec2(1,0),ivec2(-1,0),ivec2(0,1),ivec2(0,-1));
    for (int i = 0; i < 4; i++) {
      int neighbor = classAt(p + sides[i]);
      if (neighbor != cls) rim = true;
      else if (idAt(p + sides[i]) != id) boundary = true;
    }
    uint seed = unpackId(id);
    variant = foliageVariant(w, attr.gb * 2.0 - 1.0, seed, u_time, gust, rim, boundary, leafLight);
    tone = crownIsDry(seed) ? ${Tone.dry} : ${Tone.none};
  }
  // [0, 1.5] covers bounded leaf lighting; R8 error is at most 1.5/510.
  o_foliageLight = vec4(leafLight / 1.5, 0.0, 0.0, 1.0);
  vec2 glyph = texelFetch(u_table, ivec2(min(variant, u_count[cls] - 1), cls), 0).rg;
  o_glyph.r = glyph.r;
  o_glyph.g = float(cls + (int(glyph.g * 255.0 + 0.5) << 6)) / 255.0;
  o_glyph.b = float((state & ${(1 << TONE_SHIFT) - 1}) | (tone << ${TONE_SHIFT})) / 255.0;
}
`;
