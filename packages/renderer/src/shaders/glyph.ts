/**
 * Glyph pass: full-resolution draw. Each pixel finds its cell (the grid is shifted by the
 * sub-cell pan offset, so panning scrolls smoothly), reads the cell's glyph and class, samples
 * the glyph atlas, and tints it with the class color over the cell's background (the faint fill
 * of the class the select pass names, SPEC.md §4 "Two colors per cell"). Hovered cells are
 * brighter; highlighted and selected ones take the accent color, the selection with a slow
 * shimmer (SPEC.md §4 "Hover and selection").
 *
 * The life layer (SPEC.md §4 "Life layer") draws on top of the map: an agent shows where the
 * map class under it allows (life/config.ts `cellBits`). The time of day tints everything:
 * night dims the map toward blue, lights some building cells as windows and major roads with
 * streetlights, and turns on vehicles' headlights; dusk warms it.
 */
import { MAX_CLASSES } from '../classes';
import { CellBit } from '../life/config';
import { EDGE_INK, EDGE_STATE } from '../glyphs/select';
import { CellState } from '../picking';
import { cellHashGlsl } from './hash';

export const glyphFragment = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D u_glyphs;       // select pass output: glyph index, class id
uniform sampler2D u_atlas;        // R8 glyph coverage
uniform vec2 u_cell;              // cell size in device pixels
uniform vec2 u_shift;             // screen pixel + shift = pixel in the cell grid
uniform float u_height;           // canvas height in device pixels
uniform int u_columns;            // glyph slots per atlas row
uniform vec3 u_colors[${MAX_CLASSES}];
uniform float u_fills[${MAX_CLASSES}]; // background fill strength per class (0 = none)
uniform vec3 u_background;
uniform float u_time;
uniform int u_pulse;              // class id that pulses (landmarks)
uniform sampler2D u_overlay;      // RGBA8: label glyph code (lo, hi; 0 none, 1 blank)
uniform vec3 u_labelColor;
uniform vec3 u_accent;            // highlighted and selected features
uniform bool u_shimmer;           // off with reduced motion
uniform sampler2D u_life;         // RGBA8: glyph index, life class id, agent kind bit (0 none)
uniform int u_cellBits[${MAX_CLASSES}]; // per map class: CellBit set
uniform ivec2 u_origin;           // world cell of texel (0, 0), for window hashes
uniform float u_daylight;         // 0 night – 1 day
uniform int u_vehicle;            // the vehicles' class id (headlights)

out vec4 o_color;

${cellHashGlsl}

// How dark it is: none until well into twilight, so dusk reads warm rather than dim.
float darkness() {
  return smoothstep(0.3, 1.0, 1.0 - u_daylight);
}

// The time of day: dim and blue at night, warm at dusk.
vec3 daylit(vec3 color) {
  float dusk = 1.0 - abs(u_daylight - 0.5) * 2.0;
  color = mix(color, color * vec3(1.2, 0.88, 0.68), dusk * 0.45);
  return mix(color, color * vec3(0.4, 0.48, 0.78), darkness() * 0.85);
}

// A class's fill in a color: the background tinted toward it by the class's fill strength.
vec3 fillOf(int cls, vec3 color) {
  return mix(u_background, color, u_fills[cls]);
}

void main() {
  vec2 screen = vec2(gl_FragCoord.x, u_height - gl_FragCoord.y);
  vec2 grid = screen + u_shift;
  ivec2 cell = ivec2(floor(grid / u_cell));
  ivec2 inCell = ivec2(grid - vec2(cell) * u_cell);

  // Labels sit on top; their cells show the background, which gives them a halo.
  vec4 over = texelFetch(u_overlay, cell, 0);
  int code = int(over.r * 255.0 + 0.5) + 256 * int(over.g * 255.0 + 0.5);
  if (code > 0) {
    int index = code - 1;
    ivec2 at = ivec2(index % u_columns, index / u_columns) * ivec2(u_cell);
    float ink = texelFetch(u_atlas, at + inCell, 0).r;
    o_color = vec4(mix(u_background, u_labelColor, ink), 1.0);
    return;
  }

  vec4 g = texelFetch(u_glyphs, cell, 0);
  int cls = int(g.g * 255.0 + 0.5);
  int rawState = int(g.b * 255.0 + 0.5);
  bool edge = (rawState & ${EDGE_STATE}) != 0;
  int state = rawState & ${EDGE_STATE - 1};
  int bgClass = int(g.a * 255.0 + 0.5);
  float night = darkness();
  // The cell's background: its fill class's color, faint (theme.ts ClassStyle.fill).
  vec3 back = fillOf(bgClass, daylit(u_colors[bgClass]));

  // Agents stand on top where the cell under them allows.
  vec4 life = texelFetch(u_life, cell, 0);
  int lifeBit = int(life.b * 255.0 + 0.5);
  if (lifeBit != 0 && (u_cellBits[cls] & lifeBit) != 0) {
    int lifeGlyph = int(life.r * 255.0 + 0.5);
    int lifeClass = int(life.g * 255.0 + 0.5);
    ivec2 slot = ivec2(lifeGlyph % u_columns, lifeGlyph / u_columns) * ivec2(u_cell);
    float coverage = texelFetch(u_atlas, slot + inCell, 0).r;
    vec3 color = daylit(u_colors[lifeClass]);
    if (lifeClass == u_vehicle) color = mix(color, vec3(1.0, 0.95, 0.8), night * 0.7);
    o_color = vec4(mix(back, color, coverage), 1.0);
    return;
  }

  if (cls == 0) {
    o_color = vec4(back, 1.0);
    return;
  }
  int glyph = int(g.r * 255.0 + 0.5);
  ivec2 slot = ivec2(glyph % u_columns, glyph / u_columns) * ivec2(u_cell);
  float coverage = texelFetch(u_atlas, slot + inCell, 0).r;
  vec3 color = daylit(u_colors[cls]);
  if (cls == u_pulse) color *= 0.7 + 0.3 * sin(u_time * 3.0);
  int bits = u_cellBits[cls];
  if ((bits & ${CellBit.streetlight}) != 0) color = mix(color, vec3(1.0, 0.78, 0.45), night * 0.4);
  if ((bits & ${CellBit.window}) != 0 && night > 0.0) {
    // More windows light up as the night deepens; each flickers a little on its own beat.
    uint h = cellHash(u_origin + cell);
    if (float((h >> 4u) & 255u) / 255.0 < night * 0.12) {
      float beat = float((h >> 12u) & 7u) + 1.0;
      float flicker = u_shimmer ? 0.88 + 0.12 * sin(u_time * beat * 0.7) : 1.0;
      color = mix(color, vec3(1.0, 0.82, 0.48) * flicker, 0.85);
    }
  }
  if (state == ${CellState.hover}) {
    color = mix(color, vec3(1.0), 0.45);
  } else if (state == ${CellState.highlight}) {
    color = u_accent;
  } else if (state == ${CellState.selected}) {
    color = u_accent;
    if (u_shimmer) color *= 0.78 + 0.22 * sin(u_time * 2.5 - float(cell.x + cell.y) * 0.35);
  }
  // The feature's own fill takes its highlight too, so a selected footprint lights up whole.
  if (!edge && bgClass == cls) back = fillOf(cls, color);
  // A sub-cell edge draws the feature's part in a tone between its fill and its glyphs, so the
  // shape reads as one area with a crisp rim.
  if (edge) color = mix(fillOf(cls, color), color, ${EDGE_INK});
  o_color = vec4(mix(back, color, coverage), 1.0);
}
`;
