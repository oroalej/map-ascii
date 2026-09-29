/**
 * Select pass: per cell, pick the glyph from the class, its neighbors, and the world position.
 * It mirrors `glyphs/select.ts` (the unit-tested CPU version). Output (RGBA8): glyph atlas index,
 * class id, and the cell's highlight state (picking.ts `cellState`: hover, highlighted,
 * selected), which the glyph pass colors.
 */
import { Flags, MAX_CLASSES } from '../classes';
import { CellState, MAX_HIGHLIGHT } from '../picking';
import {
  BUILDING_STEPS,
  Dir,
  EXTRUDE_ROW,
  FALLING,
  kindCodes,
  OUTLINE_ZOOM,
  RIDGE_VARIANT,
  RISING,
  ROAD_AREA_ZOOM,
  RoofCode,
  ROOF_ZOOM,
  WALL_DOUBLE_ROW,
  WALL_SHADE_STEPS,
  WALL_SINGLE_ROW,
  WATER_RATE,
} from '../glyphs/select';
import { cellHashGlsl } from './hash';

const float = (n: number) => (Number.isInteger(n) ? `${n}.0` : `${n}`);

export const selectFragment = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D u_class;
uniform sampler2D u_attr;
uniform sampler2D u_id;           // packed feature ids
uniform sampler2D u_table;        // MAX_VARIANTS x MAX_CLASSES glyph indices (+ wall rows)
uniform int u_kind[${MAX_CLASSES}];
uniform int u_count[${MAX_CLASSES}];
uniform int u_connect[${MAX_CLASSES}];
uniform ivec2 u_origin;           // world cell of texel (0, 0)
uniform float u_time;             // seconds; 0 with reduced motion
uniform float u_zoom;
uniform int u_seeThrough;         // class ids outlines look through (bitmask)
uniform int u_roadMask;           // carriageway class ids (bitmask)
uniform bool u_tilted;            // perspective camera: no outlines, 3D buildings
uniform float u_cellAspect;       // cell height / width, for ridge directions
uniform uint u_hover;             // feature index under the pointer (0 = none)
uniform uint u_selected;          // selected feature index (0 = none)
uniform uint u_highlight[${MAX_HIGHLIGHT}];
uniform int u_highlightCount;

out vec4 o_glyph;

// This cell's highlight state (picking.ts cellState), set at the start of main.
float g_state = 0.0;

void emit(float glyph, int cls) {
  o_glyph = vec4(glyph, float(cls) / 255.0, g_state / 255.0, 1.0);
}

int classAt(ivec2 p) {
  p = clamp(p, ivec2(0), textureSize(u_class, 0) - 1);
  return int(texelFetch(u_class, p, 0).r * 255.0 + 0.5);
}

${cellHashGlsl}

vec4 idAt(ivec2 p) {
  p = clamp(p, ivec2(0), textureSize(u_id, 0) - 1);
  return texelFetch(u_id, p, 0);
}

// Wall mask (glyphs/select.ts wallMask): -1 inside the feature, else the N/E/S/W join bits.
// A neighbor is outside if it is another feature, unless its class is see-through.
// o[] holds "outside" for the 3x3 neighborhood: 0 NW, 1 N, 2 NE, 3 W, 5 E, 6 SW, 7 S, 8 SE.
// With byRoad, "outside" means any class that is neither a carriageway nor see-through (curbs).
int wallMask(ivec2 p, bool byRoad) {
  vec4 id = idAt(p);
  bool o[9];
  bool edge = false;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      ivec2 q = p + ivec2(dx, dy);
      int c = classAt(q);
      bool seeThrough = ((u_seeThrough >> c) & 1) == 1;
      bool outside = byRoad
        ? ((u_roadMask >> c) & 1) == 0 && !seeThrough
        : idAt(q) != id && !seeThrough;
      o[(dy + 1) * 3 + dx + 1] = outside;
      edge = edge || outside;
    }
  }
  if (!edge) return -1;
  int mask = 0;
  if (!o[1] && (o[3] || o[0] || o[5] || o[2])) mask |= ${Dir.N};
  if (!o[5] && (o[1] || o[2] || o[7] || o[8])) mask |= ${Dir.E};
  if (!o[7] && (o[3] || o[6] || o[5] || o[8])) mask |= ${Dir.S};
  if (!o[3] && (o[1] || o[0] || o[7] || o[6])) mask |= ${Dir.W};
  return mask;
}

int imod(int a, int n) {
  return ((a % n) + n) % n;
}

bool joins(int mask, ivec2 p) {
  return ((mask >> classAt(p)) & 1) == 1;
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int cls = classAt(p);
  int kind = u_kind[cls];
  if (cls == 0 || kind == 0) {
    o_glyph = vec4(0.0);
    return;
  }
  uvec4 b = uvec4(idAt(p) * 255.0 + 0.5);
  uint fid = b.r | (b.g << 8u) | (b.b << 16u) | (b.a << 24u);
  if (fid != 0u) {
    if (fid == u_selected) {
      g_state = ${CellState.selected}.0;
    } else {
      for (int i = 0; i < ${MAX_HIGHLIGHT}; i++) {
        if (i >= u_highlightCount) break;
        if (u_highlight[i] == fid) {
          g_state = ${CellState.highlight}.0;
          break;
        }
      }
      if (g_state == 0.0 && fid == u_hover) g_state = ${CellState.hover}.0;
    }
  }

  ivec2 w = u_origin + p;
  vec4 attr = texelFetch(u_attr, p, 0);
  int variant = int(attr.b * 255.0 + 0.5);

  // Carriageways at Place level: strips with curbs, blank road surface inside.
  if (((u_roadMask >> cls) & 1) == 1 && u_zoom >= ${float(ROAD_AREA_ZOOM)}) {
    int curb = wallMask(p, true);
    float glyph = curb >= 0 ? texelFetch(u_table, ivec2(curb, ${WALL_SINGLE_ROW}), 0).r : 0.0;
    emit(glyph, cls);
    return;
  }

  int flags = int(attr.g * 255.0 + 0.5);

  // 3D buildings (glyphs/select.ts extrusionVariant): solid roofs, walls shaded by facing.
  if ((flags & ${Flags.extruded}) != 0) {
    int step = (flags & ${Flags.roof}) != 0 ? 3
      : variant < ${WALL_SHADE_STEPS[0]} ? 0 : variant < ${WALL_SHADE_STEPS[1]} ? 1 : 2;
    float glyph = texelFetch(u_table, ivec2(step, ${EXTRUDE_ROW}), 0).r;
    emit(glyph, cls);
    return;
  }

  // Outlines at close zoom (glyphs/select.ts wallStyle); the tilted view shows 3D instead.
  bool landmark = (flags & ${Flags.landmark}) != 0;
  int wallRow = -1;
  if (landmark && u_zoom >= ${float(OUTLINE_ZOOM.landmark)}) {
    wallRow = kind == ${kindCodes.building} ? ${WALL_DOUBLE_ROW} : ${WALL_SINGLE_ROW};
  } else if (
    kind == ${kindCodes.building} &&
    texelFetch(u_attr, p, 0).r > 0.0 && // grounds (no height) are never outlined
    u_zoom >= ${float(OUTLINE_ZOOM.building)}
  ) {
    wallRow = ${WALL_SINGLE_ROW};
  }
  if (wallRow >= 0 && !u_tilted) {
    int mask = wallMask(p, false);
    if (mask >= 0) {
      float wall = texelFetch(u_table, ivec2(mask, wallRow), 0).r;
      emit(wall, cls);
      return;
    }
  }

  int v = 0;
  if (kind == ${kindCodes.road}) {
    int m = u_connect[cls];
    int mask = (joins(m, p + ivec2(0, -1)) ? ${Dir.N} : 0)
      | (joins(m, p + ivec2(1, 0)) ? ${Dir.E} : 0)
      | (joins(m, p + ivec2(0, 1)) ? ${Dir.S} : 0)
      | (joins(m, p + ivec2(-1, 0)) ? ${Dir.W} : 0);
    if (mask != 0) v = mask;
    else if (joins(m, p + ivec2(1, -1)) || joins(m, p + ivec2(-1, 1))) v = ${RISING};
    else if (joins(m, p + ivec2(-1, -1)) || joins(m, p + ivec2(1, 1))) v = ${FALLING};
  } else if (kind == ${kindCodes.water}) {
    uint h = cellHash(w);
    float phase = float((h >> 8u) & 255u) / 255.0;
    v = int((h + uint(floor(u_time * ${float(WATER_RATE)} + phase))) & 1u);
  } else if (kind == ${kindCodes.building}) {
    float height = attr.r * 255.0;
    v = ${BUILDING_STEPS.map((limit, i) => `height < ${float(limit)} ? ${i} : `).join('')}${BUILDING_STEPS.length};
    // Roofs from above (glyphs/select.ts roofVariant): the ridge, and lit and shaded slopes;
    // flat roofs are solid. The ridge angle is in the variant byte.
    if (height > 0.0 && !u_tilted && u_zoom >= ${float(ROOF_ZOOM)}) {
      int roof = int(attr.a * 255.0 + 0.5);
      if (roof == ${RoofCode.ridge}) {
        float theta = float(variant) / 255.0 * ${Math.PI};
        float phi = atan(sin(theta) / u_cellAspect, cos(theta));
        int bin = int(floor(phi / ${Math.PI / 4} + 0.5)) % 4;
        float ridge = texelFetch(u_table, ivec2(${RIDGE_VARIANT} + bin, ${EXTRUDE_ROW}), 0).r;
        emit(ridge, cls);
        return;
      }
      // Without a ridge (flat roofs, landmark parts) the height ramp stays.
      if (roof != ${RoofCode.none}) v = roof == ${RoofCode.shaded} ? 1 : 2;
    }
  } else if (kind == ${kindCodes.variant}) {
    v = min(variant, u_count[cls] - 1);
  } else if (kind == ${kindCodes.ramp}) {
    v = clamp(int(attr.r * 255.0 + 0.5) - 1, 0, u_count[cls] - 1);
  } else if (kind == ${kindCodes.diagonal}) {
    v = imod(w.x + w.y, u_count[cls]);
  } else if (kind == ${kindCodes.rows}) {
    v = imod(w.y, u_count[cls]);
  } else if (kind == ${kindCodes.scatter}) {
    v = int(cellHash(w) % uint(u_count[cls]));
  }
  float glyph = texelFetch(u_table, ivec2(v, cls), 0).r;
  emit(glyph, cls);
}
`;
