/**
 * Glyph pass: full-resolution draw. Each pixel finds its cell (the grid is shifted by the
 * sub-cell pan offset, so panning scrolls smoothly), reads the cell's glyph and class, samples
 * the glyph atlas, and tints it with the class color over the background.
 */
import { MAX_CLASSES } from '../classes';

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
uniform vec3 u_background;
uniform float u_time;
uniform int u_pulse;              // class id that pulses (landmarks)
uniform sampler2D u_overlay;      // RGBA8: label glyph code (lo, hi; 0 none, 1 blank)
uniform vec3 u_labelColor;

out vec4 o_color;

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
  if (cls == 0) {
    o_color = vec4(u_background, 1.0);
    return;
  }
  int glyph = int(g.r * 255.0 + 0.5);
  ivec2 slot = ivec2(glyph % u_columns, glyph / u_columns) * ivec2(u_cell);
  float coverage = texelFetch(u_atlas, slot + inCell, 0).r;
  vec3 color = u_colors[cls];
  if (cls == u_pulse) color *= 0.7 + 0.3 * sin(u_time * 3.0);
  o_color = vec4(mix(u_background, color, coverage), 1.0);
}
`;
