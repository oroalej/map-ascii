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
import {
  classId,
  Flags,
  MAX_CLASSES,
  TIER_STEP,
  PavingVariant,
  pavingOverrideDepth,
} from '../classes';
import { ROAD_AREA_ZOOM, RoofCode } from '../glyphs/select';
import { cellHashGlsl } from './hash';
import { vegetationGlsl } from './vegetation';
import { WIND_PRESETS, WIND_VARIATION } from '../life/wind';

/** Matches the strength used by raster geometry's reserved crown sweep. */
export const CROWN_WIND_MAX =
  Math.max(...Object.values(WIND_PRESETS)) * (1 + WIND_VARIATION.breathe);

const float = (n: number) => (Number.isInteger(n) ? `${n}.0` : `${n}`);

export const cellVertex = /* glsl */ `#version 300 es
layout(location = 0) in vec2 a_pos;
layout(location = 1) in vec4 a_meta; // class, height, flags, variant
layout(location = 2) in uint a_id;
layout(location = 3) in float a_ridge; // crowns: reach from the trunk; zero on ground geometry
layout(location = 4) in vec4 a_surface; // crowns: xy; roofs: along, across, ridgeHalf, endScale

uniform mat4 u_matrix; // tile units -> cell-grid clip space (affine: the map is flat)
uniform vec2 u_surfaceScale; // packed roofs: distance meters/step and endScale/step; float surfaces: 1,1
uniform float u_depth[${MAX_CLASSES}];
uniform float u_vis[${MAX_CLASSES}]; // 0-1 per class id
uniform float u_zoom;
uniform int u_roadMask; // carriageway class ids
uniform int u_ground[${MAX_CLASSES}]; // classes.ts groundClasses
uniform float u_groundDepth; // their height-less features' depth
uniform int u_crownClass;   // tree crowns, which sway in the wind
uniform float u_time;       // seconds
uniform float u_wind;       // 1, or 0 with reduced motion
uniform vec2 u_grid;        // the cell grid's columns and rows
uniform ivec2 u_origin;     // world cell of grid cell (0, 0)

flat out vec4 v_meta;
flat out uint v_id;
flat out float v_vis;
out vec4 v_surface;
flat out int v_crown;

// Features' depths fall in [0.2, 1); anything past 1 is clipped.
const float SPLIT = 0.2;

${cellHashGlsl}
${vegetationGlsl}

int maskBit(int mask, int cls) { return cls < 32 ? ((mask >> cls) & 1) : 0; }

void main() {
  int cls = int(a_meta.x + 0.5);
  bool crown = cls == u_crownClass;
  vec4 clip = u_matrix * vec4(a_pos, 0.0, 1.0);
  // Branches swing in the wind (glyphs/select.ts swayOffset): each vertex by the gust where it
  // is and its reach from the trunk (a_ridge, tile units), so the tips swing most and the lobes
  // move out of step, and spring back in the wake behind a gust.
  if (crown && (u_wind > 0.0 || u_cursorWind.z > 0.0)) {
    vec2 cell = (clip.xy * 0.5 + 0.5) * u_grid;
    vec2 front = u_wind * treeFront(u_origin + ivec2(floor(cell)), u_time);
    vec2 dir;
    front.x = min(combineWind(front.x, u_windDir, cell, dir), ${float(CROWN_WIND_MAX)});
    float cellsPerUnit = length(u_matrix[0].xy * u_grid * 0.5);
    vec2 sway = swayOffset(a_ridge * cellsPerUnit, front.x, front.y, u_time, float(gl_VertexID % 13), dir);
    clip.xy += sway / u_grid * 2.0;
  }
  // Taller features win within a tier (a_meta.y is height in meters, 0–255).
  float depth = u_depth[cls] - a_meta.y / 255.0 * ${TIER_STEP * 0.9};
  // A terrace is still paving: its sub-meter surface beats the parent plaza without
  // gaining the priority of a roof or covering planted islands.
  if (cls == ${classId('paving')} && a_meta.w > 0.0) depth -= ${TIER_STEP * 0.01};
  if (cls == ${classId('paving')} && a_meta.w == ${float(PavingVariant.override)})
    depth = ${float(pavingOverrideDepth())};
  if ((int(a_meta.z + 0.5) & ${Flags.crossing}) != 0) depth -= ${TIER_STEP * 0.01};
  // Grounds (no height) go under the grass, parks, and water on them.
  if (u_ground[cls] == 1 && a_meta.y == 0.0) depth = u_groundDepth;
  // Classes outside their zoom band are pushed out of the depth range (clipped).
  float vis = u_vis[cls];
  if (vis <= 0.0) depth = 2.0;
  // Carriageways are 1-cell lines until Place level, then strips of their real width.
  bool corridor = (int(a_meta.z + 0.5) & ${Flags.corridor}) != 0;
  bool carriageway = maskBit(u_roadMask, cls) == 1;
  if (corridor && u_zoom < ${float(ROAD_AREA_ZOOM)}) depth = 2.0;
  if (carriageway && !corridor && u_zoom >= ${float(ROAD_AREA_ZOOM)}) depth = 2.0;
  depth = depth > 1.0 ? 2.0 : SPLIT + (depth + 1.0) * 0.5 * (1.0 - SPLIT);
  gl_Position = vec4(clip.xy, depth, 1.0);
  gl_PointSize = 1.0;
  v_meta = a_meta;
  v_id = a_id;
  v_vis = vis;
  v_surface = crown ? a_surface : a_surface * vec4(vec3(u_surfaceScale.x), u_surfaceScale.y);
  v_crown = crown ? 1 : 0;
}
`;

export const cellFragment = /* glsl */ `#version 300 es
precision highp float;
precision highp int;

flat in vec4 v_meta;
flat in uint v_id;
flat in float v_vis;
in vec4 v_surface;
flat in int v_crown;

uniform ivec2 u_origin; // world cell of texel (0, 0)
uniform ivec2 u_sub;    // samples per cell: 1 x 1, or SUB for the sub-cell targets
uniform sampler2D u_crownBaseClass;
uniform sampler2D u_crownBaseAttr;
uniform int u_crownSurfaces[${MAX_CLASSES}];
uniform float u_crownOverDepth; // above roads, below point markers

layout(location = 0) out vec4 o_class;
layout(location = 1) out vec4 o_attr;
layout(location = 2) out vec4 o_id;

${cellHashGlsl}

void main() {
  gl_FragDepth = gl_FragCoord.z;
  if (v_crown == 1) {
    ivec2 p = ivec2(gl_FragCoord.xy);
    int base = int(texelFetch(u_crownBaseClass, p, 0).r * 255.0 + 0.5);
    int surface = u_crownSurfaces[base];
    float height = texelFetch(u_crownBaseAttr, p, 0).r * 255.0;
    // Ground-height building classes are grounds. Equal-height roofs win.
    if (surface == 2 && height > 0.0 && v_meta.y <= height + 0.01) discard;
    if (surface == 1 || (surface == 2 && height > 0.0)) {
      float depth = u_crownOverDepth - v_meta.y / 255.0 * ${TIER_STEP * 0.9};
      // Match the vertex shader's clip-depth split and the window-depth transform.
      gl_FragDepth = 0.8 + depth * 0.2;
    }
  }
  if (v_vis < 1.0) {
    // Hashed by cell, so the sub-cell samples keep the same cells as the cell pass.
    uint h = cellHash(u_origin + ivec2(gl_FragCoord.xy) / u_sub);
    if (float(h >> 8u) / 16777216.0 >= v_vis) discard;
  }
  o_class = vec4(v_meta.x / 255.0, 0.0, 0.0, 1.0);
  // Pitched roofs: physical along/across distances and end parameters select the face,
  // ridge or hip crossing this cell, with derivative widths at either sampling resolution.
  float roof = 0.0;
  float angle = v_meta.w;
  int flags = int(v_meta.z + 0.5);
  if ((flags & ${Flags.ridged}) != 0) {
    float along = v_surface.x, across = v_surface.y;
    float halfRidge = v_surface.z, scale = v_surface.w;
    float end = scale * (abs(along) - halfRidge), side = abs(across);
    float ridgeWidth = 0.5 * fwidth(across), hipWidth = 0.5 * fwidth(end - side);
    if (scale > 0.0 && end > side + hipWidth) {
      roof = along > 0.0 ? ${RoofCode.endPos}.0 : ${RoofCode.endNeg}.0;
    } else if (scale > 0.0 && abs(end - side) <= hipWidth && (end > 0.0 || halfRidge == 0.0)) {
      bool positive = along * across >= 0.0;
      roof = positive ? ${RoofCode.hipPos}.0 : ${RoofCode.hipNeg}.0;
      float theta = v_meta.w / 255.0 * ${Math.PI} + (positive ? 1.0 : -1.0) * atan(scale);
      angle = floor(mod(theta + ${Math.PI}, ${Math.PI}) / ${Math.PI} * 255.0 + 0.5);
    } else if ((scale == 0.0 || (halfRidge > 0.0 && end <= 0.0)) && side <= ridgeWidth) {
      roof = ${RoofCode.ridge}.0;
    } else {
      roof = across > 0.0 ? ${RoofCode.sidePos}.0 : ${RoofCode.sideNeg}.0;
    }
  }
  o_attr = vec4(v_meta.y / 255.0, v_meta.z / 255.0, angle / 255.0, roof / 255.0);
  // Crown cells don't need building flags/roof variants. Carry their local surface instead.
  if (v_crown == 1) o_attr.gb = v_surface.xy * 0.5 + 0.5;
  o_id = vec4(uvec4(v_id, v_id >> 8u, v_id >> 16u, v_id >> 24u) & 255u) / 255.0;
}
`;
