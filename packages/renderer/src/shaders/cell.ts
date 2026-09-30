/**
 * Cell pass: rasterize tile geometry into a framebuffer with one pixel per cell (and again at SUB
 * samples per cell for sub-cell edges, glyphs/select.ts). Three render targets: class id (RGBA8,
 * red only), attributes (RGBA8: height, flags, variant), and packed feature id (RGBA8). Features
 * get a depth from their class priority, so the depth test keeps the winning class.
 *
 * Zoom crossfades (classes.ts `classVisibility`): a class partly shown keeps only that share of
 * its cells, picked by a per-cell hash of the world cell, so it dissolves into what is under it
 * and the pattern stays put while panning.
 */
import { Flags, MAX_CLASSES, TIER_STEP } from '../classes';
import { ROAD_AREA_ZOOM, RoofCode } from '../glyphs/select';
import { cellHashGlsl } from './hash';
import { vegetationGlsl } from './vegetation';

const float = (n: number) => (Number.isInteger(n) ? `${n}.0` : `${n}`);

export const cellVertex = /* glsl */ `#version 300 es
layout(location = 0) in vec2 a_pos;
layout(location = 1) in vec4 a_meta; // class, height, flags, variant
layout(location = 2) in uint a_id;
layout(location = 3) in float a_ridge; // pitched roofs: signed distance to the ridge; crowns: reach from the trunk
layout(location = 4) in vec2 a_surface; // crown-local coordinates; absent on ground

uniform mat4 u_matrix; // tile units -> cell-grid clip space (affine: the map is flat)
uniform float u_depth[${MAX_CLASSES}];
uniform float u_vis[${MAX_CLASSES}]; // 0-1 per class id
uniform float u_zoom;
uniform int u_roadMask; // carriageway class ids
uniform int u_groundMask;   // classes.ts groundClasses (bitmask)
uniform float u_groundDepth; // their height-less features' depth
uniform int u_crownClass;   // tree crowns, which sway in the wind
uniform float u_time;       // seconds
uniform float u_wind;       // 1, or 0 with reduced motion
uniform vec2 u_grid;        // the cell grid's columns and rows
uniform ivec2 u_origin;     // world cell of grid cell (0, 0)

flat out vec4 v_meta;
flat out uint v_id;
flat out float v_vis;
out float v_ridge;
out vec2 v_surface;
flat out int v_crown;

// Features' depths fall in [0.2, 1); anything past 1 is clipped.
const float SPLIT = 0.2;

${cellHashGlsl}
${vegetationGlsl}

void main() {
  int cls = int(a_meta.x + 0.5);
  bool crown = cls == u_crownClass;
  vec4 clip = u_matrix * vec4(a_pos, 0.0, 1.0);
  // Branches swing in the wind (glyphs/select.ts swayOffset): each vertex by the gust where it
  // is and its reach from the trunk (a_ridge, tile units), so the tips swing most and the lobes
  // move out of step, and spring back in the wake behind a gust.
  if (crown && u_wind > 0.0) {
    vec2 cell = (clip.xy * 0.5 + 0.5) * u_grid;
    vec2 front = u_wind * treeFront(u_origin + ivec2(floor(cell)), u_time);
    float cellsPerUnit = length(u_matrix[0].xy * u_grid * 0.5);
    vec2 sway = swayOffset(a_ridge * cellsPerUnit, front.x, front.y, u_time, float(gl_VertexID % 13));
    clip.xy += sway / u_grid * 2.0;
  }
  // Taller features win within a tier (a_meta.y is height in meters, 0–255).
  float depth = u_depth[cls] - a_meta.y / 255.0 * ${TIER_STEP * 0.9};
  // Grounds (no height) go under the grass, parks, and water on them.
  if (((u_groundMask >> cls) & 1) == 1 && a_meta.y == 0.0) depth = u_groundDepth;
  // Classes outside their zoom band are pushed out of the depth range (clipped).
  float vis = u_vis[cls];
  if (vis <= 0.0) depth = 2.0;
  // Carriageways are 1-cell lines until Place level, then strips of their real width.
  bool corridor = (int(a_meta.z + 0.5) & ${Flags.corridor}) != 0;
  bool carriageway = ((u_roadMask >> cls) & 1) == 1;
  if (corridor && u_zoom < ${float(ROAD_AREA_ZOOM)}) depth = 2.0;
  if (carriageway && !corridor && u_zoom >= ${float(ROAD_AREA_ZOOM)}) depth = 2.0;
  depth = depth > 1.0 ? 2.0 : SPLIT + (depth + 1.0) * 0.5 * (1.0 - SPLIT);
  gl_Position = vec4(clip.xy, depth, 1.0);
  gl_PointSize = 1.0;
  v_meta = a_meta;
  v_id = a_id;
  v_vis = vis;
  v_ridge = a_ridge;
  v_surface = a_surface;
  v_crown = crown ? 1 : 0;
}
`;

export const cellFragment = /* glsl */ `#version 300 es
precision highp float;
precision highp int;

flat in vec4 v_meta;
flat in uint v_id;
flat in float v_vis;
in float v_ridge;
in vec2 v_surface;
flat in int v_crown;

uniform ivec2 u_origin; // world cell of texel (0, 0)
uniform ivec2 u_sub;    // samples per cell: 1 x 1, or SUB for the sub-cell targets

layout(location = 0) out vec4 o_class;
layout(location = 1) out vec4 o_attr;
layout(location = 2) out vec4 o_id;

${cellHashGlsl}

void main() {
  if (v_vis < 1.0) {
    // Hashed by cell, so the sub-cell samples keep the same cells as the cell pass.
    uint h = cellHash(u_origin + ivec2(gl_FragCoord.xy) / u_sub);
    if (float(h >> 8u) / 16777216.0 >= v_vis) discard;
  }
  o_class = vec4(v_meta.x / 255.0, 0.0, 0.0, 1.0);
  // Pitched roofs: which slope the cell is on, or the ridge if the ridge line crosses the cell
  // (the distance changes by fwidth across one cell). glyphs/select.ts roofCode.
  float roof = 0.0;
  int flags = int(v_meta.z + 0.5);
  if ((flags & ${Flags.ridged}) != 0) {
    roof = abs(v_ridge) <= 0.5 * fwidth(v_ridge) ? ${RoofCode.ridge}.0
      : v_ridge > 0.0 ? ${RoofCode.lit}.0 : ${RoofCode.shaded}.0;
  }
  o_attr = vec4(v_meta.y / 255.0, v_meta.z / 255.0, v_meta.w / 255.0, roof / 255.0);
  // Crown cells don't need building flags/roof variants. Carry their local surface instead.
  if (v_crown == 1) o_attr.gb = v_surface * 0.5 + 0.5;
  o_id = vec4(uvec4(v_id, v_id >> 8u, v_id >> 16u, v_id >> 24u) & 255u) / 255.0;
}
`;
