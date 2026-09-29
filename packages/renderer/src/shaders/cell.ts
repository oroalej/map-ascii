/**
 * Cell pass: rasterize tile geometry into a framebuffer with one pixel per cell. Three render
 * targets: class id (R8), attributes (RGBA8: height, flags, variant), and packed feature id
 * (RGBA8). Ground features get a depth from their class priority, so the depth test keeps the
 * winning class; 3D building extrusions (tilted cameras) use their real depth in front of all
 * ground, so buildings hide what is behind them and each other.
 *
 * Zoom crossfades (classes.ts `classVisibility`): a class partly shown keeps only that share of
 * its cells, picked by a per-cell hash of the world cell, so it dissolves into what is under it
 * and the pattern stays put while panning.
 */
import { Flags, MAX_CLASSES, TIER_STEP } from '../classes';
import { ROAD_AREA_ZOOM, RoofCode } from '../glyphs/select';
import { cellHashGlsl } from './hash';

const float = (n: number) => (Number.isInteger(n) ? `${n}.0` : `${n}`);

export const cellVertex = /* glsl */ `#version 300 es
layout(location = 0) in vec2 a_pos;
layout(location = 1) in vec4 a_meta; // class, height, flags, variant
layout(location = 2) in uint a_id;
layout(location = 3) in float a_ridge; // pitched roofs: signed distance to the ridge

uniform mat4 u_matrix; // tile units (x, y) and meters (z) -> cell-grid clip space
uniform float u_depth[${MAX_CLASSES}];
uniform float u_vis[${MAX_CLASSES}]; // 0-1 per class id
uniform float u_zoom;
uniform int u_roadMask; // carriageway class ids

flat out vec4 v_meta;
flat out uint v_id;
flat out float v_vis;
out float v_ridge;

// Depth ranges: extrusions [-1, 0.2), ground [0.2, 1); anything past 1 is clipped.
const float SPLIT = 0.2;

void main() {
  int cls = int(a_meta.x + 0.5);
  int flags = int(a_meta.z + 0.5);
  bool extruded = (flags & ${Flags.extruded}) != 0;
  float z = (flags & ${Flags.top}) != 0 ? a_meta.y : 0.0;
  vec4 clip = u_matrix * vec4(a_pos, z, 1.0);
  // Taller features win within a tier (a_meta.y is height in meters, 0–255).
  float depth = u_depth[cls] - a_meta.y / 255.0 * ${TIER_STEP * 0.9};
  // Classes outside their zoom band are pushed out of the depth range (clipped).
  float vis = u_vis[cls];
  if (vis <= 0.0) depth = 2.0;
  // Carriageways are 1-cell lines until Place level, then strips of their real width.
  bool corridor = (int(a_meta.z + 0.5) & ${Flags.corridor}) != 0;
  bool carriageway = ((u_roadMask >> cls) & 1) == 1;
  if (corridor && u_zoom < ${float(ROAD_AREA_ZOOM)}) depth = 2.0;
  if (carriageway && !corridor && u_zoom >= ${float(ROAD_AREA_ZOOM)}) depth = 2.0;
  if (depth > 1.0) {
    depth = 2.0;
  } else if (extruded) {
    depth = mix(-1.0, SPLIT, clamp(clip.z / clip.w * 0.5 + 0.5, 0.0, 1.0));
  } else {
    depth = SPLIT + (depth + 1.0) * 0.5 * (1.0 - SPLIT);
  }
  gl_Position = vec4(clip.xy, depth * clip.w, clip.w);
  gl_PointSize = 1.0;
  v_meta = a_meta;
  v_id = a_id;
  v_vis = vis;
  v_ridge = a_ridge;
}
`;

export const cellFragment = /* glsl */ `#version 300 es
precision highp float;
precision highp int;

flat in vec4 v_meta;
flat in uint v_id;
flat in float v_vis;
in float v_ridge;

uniform ivec2 u_origin; // world cell of texel (0, 0) (flat views; 0 when tilted)

layout(location = 0) out vec4 o_class;
layout(location = 1) out vec4 o_attr;
layout(location = 2) out vec4 o_id;

${cellHashGlsl}

void main() {
  if (v_vis < 1.0) {
    uint h = cellHash(u_origin + ivec2(gl_FragCoord.xy));
    if (float(h >> 8u) / 16777216.0 >= v_vis) discard;
  }
  o_class = vec4(v_meta.x / 255.0, 0.0, 0.0, 1.0);
  // Pitched roofs: which slope the cell is on, or the ridge if the ridge line crosses the cell
  // (the distance changes by fwidth across one cell). glyphs/select.ts roofCode.
  float roof = 0.0;
  if ((int(v_meta.z + 0.5) & ${Flags.ridged}) != 0) {
    roof = abs(v_ridge) <= 0.5 * fwidth(v_ridge) ? ${RoofCode.ridge}.0
      : v_ridge > 0.0 ? ${RoofCode.lit}.0 : ${RoofCode.shaded}.0;
  }
  o_attr = vec4(v_meta.y / 255.0, v_meta.z / 255.0, v_meta.w / 255.0, roof / 255.0);
  o_id = vec4(uvec4(v_id, v_id >> 8u, v_id >> 16u, v_id >> 24u) & 255u) / 255.0;
}
`;
