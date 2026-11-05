import { FOCUS_DIM } from '../focus';
import { SPRITE_COLUMNS, SPRITE_ROWS, SPRITE_SIZE } from '../life/manananggal-frames';

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
uniform sampler2D u_sprites;
uniform int u_columns;
uniform vec2 u_cell;
uniform sampler2D u_overlay;
uniform vec2 u_labelCell;
uniform vec2 u_labelShift;
uniform float u_height;
uniform vec3 u_accent;
uniform int u_focusMode;
uniform float u_pulse;
out vec4 o_color;
const int SPRITE_COLUMNS = ${SPRITE_COLUMNS};
const vec2 SPRITE_GRID = vec2(${SPRITE_COLUMNS}.0, ${SPRITE_ROWS}.0);
const vec3 GLOW = vec3(0.75, 0.09, 0.16);
vec4 spriteFrame(int frame, vec2 uv) {
  return texture(u_sprites, (vec2(frame % SPRITE_COLUMNS, frame / SPRITE_COLUMNS) + uv) / SPRITE_GRID);
}
void main() {
  ivec2 label = ivec2(floor(
    (vec2(gl_FragCoord.x, u_height - gl_FragCoord.y) + u_labelShift) / u_labelCell
  ));
  vec4 cover = texelFetch(u_overlay, label, 0);
  if (cover.r > 0.0 || cover.g > 0.0 || cover.b > 0.0) discard;
  int code = int(v_style.x + 0.5);
  float halo = pow(max(0.0, 1.0 - length((v_uv - 0.5) * 2.0)), 2.0);
  vec3 color;
  float alpha;
  if (v_style.z < 0.5) {
    vec2 slot = vec2(code % u_columns, code / u_columns);
    ivec2 pixel = ivec2(slot * u_cell + min(floor(v_uv * u_cell), u_cell - 1.0));
    float ink = texelFetch(u_atlas, pixel, 0).r;
    color = vec3(0.73, 0.94, 1.0);
    alpha = v_style.y * max(ink, halo * 0.22);
  } else {
    // The top frame over the one under it, turned about the middle of the quad. Its pixels stay
    // square on the screen at any heading, like the map's cells, rather than tilting with it.
    vec2 d = (floor(v_uv * ${SPRITE_SIZE}.0) + 0.5) / ${SPRITE_SIZE}.0 - 0.5;
    float c = cos(v_style.w), s = sin(v_style.w);
    vec2 uv = vec2(c * d.x + s * d.y, c * d.y - s * d.x) + 0.5;
    vec4 figure = vec4(0.0);
    if (all(greaterThanEqual(uv, vec2(0.0))) && all(lessThan(uv, vec2(1.0)))) {
      figure = spriteFrame(code % 64, uv);
      if (code >= 64 && figure.a < 1.0) {
        vec4 under = spriteFrame(code / 64 - 1, uv);
        figure = vec4(mix(under.rgb, figure.rgb, figure.a), max(figure.a, under.a));
      }
    }
    color = mix(GLOW, figure.rgb, figure.a);
    alpha = v_style.y * max(figure.a, halo * (v_style.z < 1.5 ? 0.16 : 0.05));
  }
  if (u_focusMode == 2) color = u_accent * u_pulse;
  else if (u_focusMode == 1) color *= ${FOCUS_DIM.toFixed(1)};
  if (alpha < 0.001) discard;
  o_color = vec4(color, alpha);
}`;
