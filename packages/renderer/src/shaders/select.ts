/**
 * Select pass: per cell, pick the glyph from the class, its neighbors, and the world position.
 * It mirrors `glyphs/select.ts` (the unit-tested CPU version). Output (RGBA8): glyph atlas index,
 * class id.
 */
import { MAX_CLASSES } from '../classes';
import { BUILDING_STEPS, Dir, FALLING, kindCodes, RISING, WATER_RATE } from '../glyphs/select';

const float = (n: number) => (Number.isInteger(n) ? `${n}.0` : `${n}`);

export const selectFragment = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D u_class;
uniform sampler2D u_attr;
uniform sampler2D u_table;        // MAX_VARIANTS x MAX_CLASSES glyph indices
uniform int u_kind[${MAX_CLASSES}];
uniform int u_count[${MAX_CLASSES}];
uniform int u_connect[${MAX_CLASSES}];
uniform ivec2 u_origin;           // world cell of texel (0, 0)
uniform float u_time;             // seconds; 0 with reduced motion

out vec4 o_glyph;

int classAt(ivec2 p) {
  p = clamp(p, ivec2(0), textureSize(u_class, 0) - 1);
  return int(texelFetch(u_class, p, 0).r * 255.0 + 0.5);
}

uint cellHash(ivec2 c) {
  uvec2 p = uvec2(c);
  uint h = (p.x * 0x8da6b343u) ^ (p.y * 0xd8163841u);
  h ^= h >> 13u;
  h *= 0x5bd1e995u;
  h ^= h >> 15u;
  return h;
}

int imod(int a, int n) {
  return ((a % n) + n) % n;
}

bool joins(int mask, ivec2 p) {
  return ((mask >> classAt(p)) & 1) == 1;
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int cls = classAt(p);
  int kind = u_kind[cls];
  if (cls == 0 || kind == 0) {
    o_glyph = vec4(0.0);
    return;
  }
  ivec2 w = u_origin + p;
  int v = 0;
  if (kind == ${kindCodes.road}) {
    int m = u_connect[cls];
    int mask = (joins(m, p + ivec2(0, -1)) ? ${Dir.N} : 0)
      | (joins(m, p + ivec2(1, 0)) ? ${Dir.E} : 0)
      | (joins(m, p + ivec2(0, 1)) ? ${Dir.S} : 0)
      | (joins(m, p + ivec2(-1, 0)) ? ${Dir.W} : 0);
    if (mask != 0) v = mask;
    else if (joins(m, p + ivec2(1, -1)) || joins(m, p + ivec2(-1, 1))) v = ${RISING};
    else if (joins(m, p + ivec2(-1, -1)) || joins(m, p + ivec2(1, 1))) v = ${FALLING};
  } else if (kind == ${kindCodes.water}) {
    uint h = cellHash(w);
    float phase = float((h >> 8u) & 255u) / 255.0;
    v = int((h + uint(floor(u_time * ${float(WATER_RATE)} + phase))) & 1u);
  } else if (kind == ${kindCodes.building}) {
    float height = texelFetch(u_attr, p, 0).r * 255.0;
    v = ${BUILDING_STEPS.map((limit, i) => `height < ${float(limit)} ? ${i} : `).join('')}${BUILDING_STEPS.length};
  } else if (kind == ${kindCodes.diagonal}) {
    v = imod(w.x + w.y, u_count[cls]);
  } else if (kind == ${kindCodes.rows}) {
    v = imod(w.y, u_count[cls]);
  } else if (kind == ${kindCodes.scatter}) {
    v = int(cellHash(w) % uint(u_count[cls]));
  }
  float glyph = texelFetch(u_table, ivec2(v, cls), 0).r;
  o_glyph = vec4(glyph, float(cls) / 255.0, 0.0, 1.0);
}
`;
