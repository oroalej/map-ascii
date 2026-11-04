/**
 * The boot shaders: a plain map while the full select and glyph programs compile, which takes
 * about a minute on a cold shader cache through ANGLE D3D11 (ARCHITECTURE.md §8). They write and
 * read the full passes' texel layouts (shaders/select.ts, shaders/glyph.ts) and declare a subset
 * of their uniforms, so the same passes draw them. Keep them small: their whole job is to link
 * quickly. No wind, shadows, walls, sub-cell edges, lamps, Life or fixtures.
 */
import { MAX_CLASSES } from '../classes';
import { BUILDING_STEPS, Dir, FALLING, kindCodes, RISING, ROAD_AREA_ZOOM } from '../glyphs/select';
import { cellHashGlsl } from './hash';

const float = (n: number) => (Number.isInteger(n) ? `${n}.0` : `${n}`);

/** The straight-through connections a carriageway strip's edge draws. */
const THROUGH_NS = Dir.N | Dir.S;
const THROUGH_EW = Dir.E | Dir.W;
const ALL_SIDES = THROUGH_NS | THROUGH_EW;

export const bootSelectFragment = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D u_class;
uniform sampler2D u_baseClass;
uniform sampler2D u_attr;
uniform sampler2D u_table;
uniform int u_kind[${MAX_CLASSES}];
uniform int u_count[${MAX_CLASSES}];
uniform int u_connect[${MAX_CLASSES}];
uniform ivec2 u_origin;
uniform int u_roadMask;
uniform float u_zoom;

layout(location = 0) out vec4 o_glyph;
layout(location = 1) out vec4 o_shade;

${cellHashGlsl}

bool joins(int mask, ivec2 p) {
  int c = int(texelFetch(u_baseClass, clamp(p, ivec2(0), textureSize(u_class, 0) - 1), 0).r * 255.0 + 0.5);
  return c < 32 && ((mask >> c) & 1) == 1;
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  o_shade = vec4(1.0);
  o_glyph = vec4(0.0);
  int cls = int(texelFetch(u_class, p, 0).r * 255.0 + 0.5);
  int kind = u_kind[cls];
  if (cls == 0 || kind == 0) return;
  vec4 attr = texelFetch(u_attr, p, 0);
  ivec2 w = u_origin + p;
  int count = max(u_count[cls], 1);
  int v = 0;
  bool isRoad = cls < 32 && ((u_roadMask >> cls) & 1) == 1;
  bool strip = isRoad && u_zoom >= ${float(ROAD_AREA_ZOOM)};
  bool blank = false;
  if (kind == ${kindCodes.road}) {
    int m = u_connect[cls];
    int mask = (joins(m, p + ivec2(0, -1)) ? ${Dir.N} : 0)
      | (joins(m, p + ivec2(1, 0)) ? ${Dir.E} : 0)
      | (joins(m, p + ivec2(0, 1)) ? ${Dir.S} : 0)
      | (joins(m, p + ivec2(-1, 0)) ? ${Dir.W} : 0);
    if (strip) {
      blank = mask == ${ALL_SIDES};
      v = (mask & ${THROUGH_NS}) == ${THROUGH_NS} ? ${THROUGH_NS} : ${THROUGH_EW};
    } else if (mask != 0) v = mask;
    else if (joins(m, p + ivec2(1, -1)) || joins(m, p + ivec2(-1, 1))) v = ${RISING};
    else if (joins(m, p + ivec2(-1, -1)) || joins(m, p + ivec2(1, 1))) v = ${FALLING};
  } else if (kind == ${kindCodes.building}) {
    float height = attr.r * 255.0;
    v = ${BUILDING_STEPS.map((limit, i) => `height < ${float(limit)} ? ${i} : `).join('')}${BUILDING_STEPS.length};
  } else if (kind == ${kindCodes.variant}) {
    v = min(int(attr.b * 255.0 + 0.5), count - 1);
  } else if (kind == ${kindCodes.ramp}) {
    v = clamp(int(attr.r * 255.0 + 0.5) - 1, 0, count - 1);
  } else if (kind == ${kindCodes.rows}) {
    v = (w.y % count + count) % count;
  } else if (kind != ${kindCodes.single}) {
    v = int(cellHash(w) % uint(min(count, 3)));
  }
  vec2 glyph = blank ? vec2(0.0) : texelFetch(u_table, ivec2(v, cls), 0).rg;
  int bg = isRoad && !strip ? 0 : cls;
  o_glyph = vec4(glyph.x, float(cls + (int(glyph.y * 255.0 + 0.5) << 6)) / 255.0, 0.0, float(bg) / 255.0);
}
`;

export const bootGlyphFragment = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D u_glyphs;
uniform sampler2D u_atlas;
uniform vec2 u_cell;
uniform vec2 u_shift;
uniform float u_height;
uniform int u_columns;
uniform vec3 u_colors[${MAX_CLASSES}];
uniform vec3 u_fillColors[${MAX_CLASSES}];
uniform float u_fills[${MAX_CLASSES}];
uniform vec3 u_background;
uniform sampler2D u_overlay;
uniform sampler2D u_labelAtlas;
uniform vec2 u_labelCell;
uniform vec2 u_labelShift;
uniform int u_labelColumns;
uniform vec3 u_labelColor;
uniform float u_daylight;
uniform float u_moon;

out vec4 o_color;

vec3 daylit(vec3 color) {
  float night = smoothstep(0.3, 1.0, 1.0 - u_daylight);
  float dusk = 1.0 - abs(u_daylight - 0.5) * 2.0;
  color = mix(color, color * vec3(1.2, 0.88, 0.68), dusk * 0.45);
  vec3 tint = mix(vec3(0.4, 0.48, 0.78), vec3(0.6, 0.64, 0.76), u_moon);
  return mix(color, color * tint, night * (0.85 - 0.2 * u_moon));
}

void main() {
  vec2 screen = vec2(gl_FragCoord.x, u_height - gl_FragCoord.y);
  vec2 labelGrid = screen + u_labelShift;
  ivec2 labelCell = ivec2(floor(labelGrid / u_labelCell));
  vec4 over = texelFetch(u_overlay, labelCell, 0);
  int code = int(over.r * 255.0 + 0.5) + 256 * int(over.g * 255.0 + 0.5);
  if (code > 0) {
    int index = code - 1;
    ivec2 at = ivec2(index % u_labelColumns, index / u_labelColumns) * ivec2(u_labelCell);
    ivec2 inLabel = ivec2(labelGrid - vec2(labelCell) * u_labelCell);
    o_color = vec4(mix(u_background, u_labelColor, texelFetch(u_labelAtlas, at + inLabel, 0).r), 1.0);
    return;
  }
  vec2 grid = screen + u_shift;
  ivec2 cell = ivec2(floor(grid / u_cell));
  ivec2 inCell = ivec2(grid - vec2(cell) * u_cell);
  vec4 g = texelFetch(u_glyphs, cell, 0);
  int high = int(g.g * 255.0 + 0.5);
  int cls = high & 63;
  int bg = int(g.a * 255.0 + 0.5);
  vec3 pigment = daylit(u_colors[bg]) * u_fillColors[bg] / max(u_colors[bg], vec3(1.0 / 255.0));
  vec3 back = mix(u_background, pigment, u_fills[bg]);
  int glyph = int(g.r * 255.0 + 0.5) + 256 * (high >> 6);
  ivec2 slot = ivec2(glyph % u_columns, glyph / u_columns) * ivec2(u_cell);
  float coverage = texelFetch(u_atlas, slot + inCell, 0).r;
  o_color = vec4(mix(back, daylit(u_colors[cls]), coverage), 1.0);
}
`;
