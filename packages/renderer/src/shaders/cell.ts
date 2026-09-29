/**
 * Cell pass: rasterize tile geometry into a framebuffer with one pixel per cell. Three render
 * targets: class id (R8), attributes (RGBA8: height, flags), and packed feature id (RGBA8).
 * Draw priority is the depth value per class, so the depth test keeps the winning class.
 */
import { TIER_STEP } from '../classes';

export const cellVertex = /* glsl */ `#version 300 es
layout(location = 0) in vec2 a_pos;
layout(location = 1) in vec4 a_meta; // class, height, flags, 0
layout(location = 2) in uint a_id;

uniform vec2 u_scale;  // tile units -> clip space
uniform vec2 u_offset;
uniform float u_depth[32];

flat out vec4 v_meta;
flat out uint v_id;

void main() {
  int cls = int(a_meta.x + 0.5);
  // Taller features win within a tier (a_meta.y is height in meters, 0–255).
  float depth = u_depth[cls] - a_meta.y / 255.0 * ${TIER_STEP * 0.9};
  gl_Position = vec4(a_pos * u_scale + u_offset, depth, 1.0);
  gl_PointSize = 1.0;
  v_meta = a_meta;
  v_id = a_id;
}
`;

export const cellFragment = /* glsl */ `#version 300 es
precision highp float;
precision highp int;

flat in vec4 v_meta;
flat in uint v_id;

layout(location = 0) out vec4 o_class;
layout(location = 1) out vec4 o_attr;
layout(location = 2) out vec4 o_id;

void main() {
  o_class = vec4(v_meta.x / 255.0, 0.0, 0.0, 1.0);
  o_attr = vec4(v_meta.y / 255.0, v_meta.z / 255.0, 0.0, 1.0);
  o_id = vec4(uvec4(v_id, v_id >> 8u, v_id >> 16u, v_id >> 24u) & 255u) / 255.0;
}
`;
