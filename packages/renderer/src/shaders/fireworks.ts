import { FIREWORKS } from '../fireworks-layout';

/** Fixed instanced quads: all burst, tail and smoke motion stays on the GPU. */
export const fireworksVertex = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in vec4 a_particle; // shell, star/puff, tail, smoke
uniform vec4 u_shells[${FIREWORKS.shells}]; // screen center, seed, radius
uniform vec2 u_flights[${FIREWORKS.shells}]; // age, time to reach break height
uniform vec2 u_appearance[${FIREWORKS.shells}]; // visibility below camera, spark ink width
uniform vec2 u_size;
uniform vec2 u_cell;
uniform vec2 u_wind;
uniform int u_variants[4];
uniform int u_variantCount;
uniform int u_codes[7]; // dot, star, plus and four trail directions
out vec2 v_uv;
flat out vec4 v_color;
flat out int v_code;
flat out float v_smoke;
flat out float v_scale;
float rand(float seed) { return fract(sin(seed * 12.9898 + 78.233) * 43758.5453); }
vec3 paint(float seed) {
  int p = int(mod(seed, 6.0));
  if (p == 0) return vec3(1.0, 0.24, 0.38);
  if (p == 1) return vec3(1.0, 0.77, 0.18);
  if (p == 2) return vec3(0.2, 1.0, 0.68);
  if (p == 3) return vec3(0.35, 0.7, 1.0);
  if (p == 4) return vec3(1.0, 0.35, 0.87);
  return vec3(0.78, 0.55, 1.0);
}
void main() {
  int shell = int(a_particle.x);
  float star = a_particle.y, tail = a_particle.z;
  bool smoke = a_particle.w > 0.5;
  vec4 launch = u_shells[shell];
  float seed = launch.z;
  float age = u_flights[shell].x;
  float rise = u_flights[shell].y;
  int variant = u_variants[int(mod(seed, float(u_variantCount)))];
  float t = age - rise;
  float r = launch.w;
  float angle = star / ${FIREWORKS.stars.toFixed(1)} * 6.2831853 + rand(seed) * 6.2831853;
  float speed = variant == 2 ? 1.0 : 0.45 + rand(seed + star * 13.0) * 0.55;
  if (variant == 1) speed = 0.68 + mod(star, 3.0) * 0.16;
  if (variant == 3) speed = 0.65 + rand(seed + star) * 0.35;
  float dt = max(0.0, t - tail * (variant == 3 ? 0.35 : 0.16));
  float distance = (1.0 - exp(-dt * 1.15)) * r * speed;
  // North-up plan view: spherical breaks become radial patterns, without a fake horizon.
  float curl = variant == 3 ? dt * 0.22 : 0.0;
  vec2 p = launch.xy + vec2(cos(angle + curl), sin(angle + curl)) * distance;
  p += u_wind * dt * 4.0;
  float opacity = smoothstep(0.0, 0.16, t) * (1.0 - smoothstep(1.6, ${FIREWORKS.sparkLife.toFixed(1)}, t));
  opacity *= exp(-tail * 0.52);
  if (variant == 0 && tail > 1.0) opacity = 0.0;
  if (variant == 2 && tail > 0.0) opacity = 0.0;
  if (variant == 3) opacity *= 0.8 + 0.2 * sin(star * 1.9 + dt * 5.0);
  vec3 color = variant == 3 ? vec3(1.0, 0.78, 0.28) : paint(seed + floor(star / 8.0));
  color = mix(color, vec3(1.0, 0.95, 0.78), (1.0 - smoothstep(0.0, 0.6, t)) * 0.5);
  int code = u_codes[tail > 0.0 ? 0 : 1];
  if (tail > 0.0) {
    int direction = abs(cos(angle + curl)) > 0.85 ? 3 : (abs(sin(angle + curl)) > 0.85 ? 5 : (sin(angle + curl) * cos(angle + curl) > 0.0 ? 6 : 4));
    code = u_codes[direction];
  }
  if (variant == 1 && tail == 0.0) code = u_codes[2];
  float scale = tail > 0.0 ? 1.5 : 2.6;
  vec2 inkCell = vec2(u_appearance[shell].y, u_appearance[shell].y * 1.8);
  vec2 quad = inkCell * scale;
  if (smoke) {
    float puffAngle = star / ${FIREWORKS.smoke.toFixed(1)} * 6.2831853 + rand(seed) * 6.2831853;
    float spread = max(0.0, t) * r * 0.095 + r * 0.11;
    p = launch.xy + vec2(cos(puffAngle), sin(puffAngle)) * spread;
    p += u_wind * max(0.0, t) * 14.0;
    quad = vec2(r * (0.24 + max(0.0, t) * 0.045));
    opacity = smoothstep(0.3, 1.5, t) * (1.0 - smoothstep(2.8, ${FIREWORKS.smokeLife.toFixed(1)}, t)) * 0.16;
    color = mix(vec3(0.53, 0.58, 0.65), color, 0.14);
    code = u_codes[0];
  } else {
    if (age < rise) {
      // Seen from above, a rising shell approaches us: its glow grows at its world site,
      // with slight horizontal drift rather than a side-view rocket crossing the map.
      float progress = clamp(age / rise, 0.0, 1.0);
      p = launch.xy - u_wind * (1.0 - progress) * rise * 4.0;
      scale = mix(0.65, 3.0 + rise * 0.35, progress * progress);
      quad = inkCell * scale;
      opacity = star < 1.0 && tail < 1.0 ? mix(0.3, 0.95, progress) : 0.0;
      color = vec3(1.0, 0.88, 0.52);
      code = u_codes[2];
    }
    // Aerial glyph centers follow their continuous projection, independent of the ground grid.
  }
  opacity *= u_appearance[shell].x;
  vec2 corner = vec2(float((gl_VertexID == 1 || gl_VertexID == 2 || gl_VertexID == 4) ? 1 : 0),
                     float((gl_VertexID == 2 || gl_VertexID == 4 || gl_VertexID == 5) ? 1 : 0));
  vec2 screen = p + (corner - 0.5) * quad;
  // Expired/invisible particles have no fragments, even when close zoom enlarges their quads.
  gl_Position = opacity < 0.002 ? vec4(2.0, 2.0, 0.0, 1.0) :
    vec4(screen.x / u_size.x * 2.0 - 1.0, 1.0 - screen.y / u_size.y * 2.0, 0.0, 1.0);
  v_uv = corner;
  v_code = code;
  v_color = vec4(color, opacity);
  v_smoke = smoke ? 1.0 : 0.0;
  v_scale = scale;
}`;

export const fireworksFragment = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
in vec2 v_uv;
flat in vec4 v_color;
flat in int v_code;
flat in float v_smoke;
flat in float v_scale;
uniform sampler2D u_atlas;
uniform sampler2D u_overlay;
uniform int u_columns;
uniform vec2 u_cell;
uniform vec2 u_labelCell;
uniform vec2 u_labelShift;
uniform float u_height;
uniform float u_daylight;
out vec4 o_color;
void main() {
  if (v_color.a < 0.002) discard;
  vec2 screen = vec2(gl_FragCoord.x, u_height - gl_FragCoord.y);
  ivec2 label = ivec2(floor((screen + u_labelShift) / u_labelCell));
  ivec2 bounds = textureSize(u_overlay, 0);
  if (all(greaterThanEqual(label, ivec2(0))) && all(lessThan(label, bounds))) {
    vec4 over = texelFetch(u_overlay, label, 0);
    if (over.r > 0.0 || over.g > 0.0) discard;
  }
  float ink;
  if (v_smoke > 0.5) {
    vec2 p = v_uv * 2.0 - 1.0;
    float cloud = 1.0 - smoothstep(0.2, 1.0, dot(p, p));
    // Sparse ASCII-like grains, not a solid translucent rectangle.
    vec2 grain = fract(screen / u_cell * vec2(2.0, 3.0));
    ink = cloud * (1.0 - smoothstep(0.14, 0.36, length(grain - 0.5)));
  } else {
    ivec2 at = ivec2(v_code % u_columns, v_code / u_columns) * ivec2(u_cell);
    vec2 glyphUv = (v_uv - 0.5) * v_scale + 0.5;
    vec2 sampleAt = vec2(at) + clamp(glyphUv * u_cell, vec2(0.5), u_cell - 0.5);
    ink = all(greaterThanEqual(glyphUv, vec2(0.0))) && all(lessThanEqual(glyphUv, vec2(1.0))) ? texture(u_atlas, sampleAt / vec2(textureSize(u_atlas, 0))).r : 0.0;
    // A small local glow joins sparks without a full-screen flash.
    vec2 glow = (v_uv - 0.5) * v_scale;
    ink = max(ink, exp(-dot(glow, glow) * 2.6) * 0.28);
  }
  o_color = vec4(v_color.rgb, ink * v_color.a * mix(1.0, 0.85, u_daylight));
}`;
