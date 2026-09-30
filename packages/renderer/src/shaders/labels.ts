/** Batched glyph quads for whole street names rotated in screen pixels. */
export const labelVertex = /* glsl */ `#version 300 es
layout(location = 0) in vec2 a_position;
layout(location = 1) in vec2 a_uv;
layout(location = 2) in float a_code;
uniform vec2 u_size;
uniform vec2 u_shift;
out vec2 v_uv;
flat out int v_code;
void main() {
  vec2 p = (a_position - u_shift) / u_size;
  gl_Position = vec4(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, 0.0, 1.0);
  v_uv = a_uv;
  v_code = int(a_code + 0.5);
}`;
export const labelFragment = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
in vec2 v_uv;
flat in int v_code;
uniform sampler2D u_atlas;
uniform vec2 u_cell;
uniform int u_columns;
uniform vec3 u_color;
uniform vec3 u_background;
out vec4 o_color;
void main() {
  float ink = 0.0;
  if (v_code > 0) {
    ivec2 at = ivec2(v_code % u_columns, v_code / u_columns) * ivec2(u_cell);
    vec2 sampleAt = vec2(at) + clamp(v_uv * u_cell, vec2(0.5), u_cell - 0.5);
    ink = texture(u_atlas, sampleAt / vec2(textureSize(u_atlas, 0))).r;
  }
  o_color = vec4(mix(u_background, u_color, ink), 1.0);
}`;
