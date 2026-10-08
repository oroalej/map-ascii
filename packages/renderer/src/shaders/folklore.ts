export const folkloreVertex = `#version 300 es
precision highp float;
layout(location=0) in vec4 a_quad;
layout(location=1) in vec4 a_style;
uniform vec2 u_size;
out vec2 v_uv;
flat out vec4 v_style;
void main() {
  vec2 p = vec2(
    (gl_VertexID == 1 || gl_VertexID == 2 || gl_VertexID == 4) ? 1.0 : 0.0,
    (gl_VertexID == 2 || gl_VertexID == 4 || gl_VertexID == 5) ? 1.0 : 0.0
  );
  v_uv = p;
  v_style = a_style;
  vec2 xy = a_quad.xy + (p - 0.5) * a_quad.zw;
  gl_Position = vec4(xy / u_size * vec2(2.0, -2.0) + vec2(-1.0, 1.0), 0, 1);
}`;

export const folkloreFragment = `#version 300 es
precision highp float;
precision highp int;
in vec2 v_uv;
flat in vec4 v_style;
uniform sampler2D u_atlas;
uniform int u_columns;
uniform vec2 u_cell;
uniform sampler2D u_overlay;
uniform vec2 u_labelCell;
uniform vec2 u_labelShift;
uniform float u_height;
out vec4 o_color;
void main() {
  ivec2 label = ivec2(floor(
    (vec2(gl_FragCoord.x, u_height - gl_FragCoord.y) + u_labelShift) / u_labelCell
  ));
  vec4 cover = texelFetch(u_overlay, label, 0);
  if (cover.r > 0.0 || cover.g > 0.0 || cover.b > 0.0) discard;
  int code = int(v_style.x);
  vec2 slot = vec2(code % u_columns, code / u_columns);
  ivec2 pixel = ivec2(slot * u_cell + min(floor(v_uv * u_cell), u_cell - 1.0));
  float ink = texelFetch(u_atlas, pixel, 0).r;
  float halo = pow(max(0.0, 1.0 - length((v_uv - 0.5) * 2.0)), 2.0) * 0.22;
  bool ghost = v_style.z < 0.5;
  vec3 color = ghost ? vec3(0.73, 0.94, 1.0)
    : mix(vec3(0.05, 0.02, 0.09), vec3(0.75, 0.09, 0.16), halo * 3.0);
  float alpha = v_style.y * max(ink, halo);
  if (alpha < 0.001) discard;
  o_color = vec4(color, alpha);
}`;
