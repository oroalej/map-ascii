/**
 * Select pass: per cell, pick the glyph from the class, its neighbors, and the world position.
 * It mirrors `glyphs/select.ts` (the unit-tested CPU version). Output (RGBA8): glyph atlas index,
 * class id, the cell's state (picking.ts `cellState`: hover, highlighted, selected; plus
 * `EDGE_STATE` for a sub-cell edge, `SHADOW_STATE`, and vegetation's wind level and tone; see
 * glyphs/select.ts), and the class whose fill is the cell's background.
 *
 * Flat views also get the cell pass at `SUB` samples per cell: where an area's edge crosses a
 * cell, the cell draws the sextant of the samples inside it (glyphs/select.ts `subcellEdge`).
 */
import { Flags, MAX_CLASSES } from '../classes';
import { CellState, MAX_HIGHLIGHT } from '../picking';
import {
  BUILDING_STEPS,
  Dir,
  EDGE_STATE,
  SHADOW,
  SHADOW_STATE,
  DEFAULT_SUN,
  GUST_STEPS,
  Tone,
  TONE_SHIFT,
  WIND_SHIFT,
  FALLING,
  kindCodes,
  OUTLINE_ZOOM,
  RIDGE_VARIANT,
  RISING,
  ROAD_AREA_ZOOM,
  RoofCode,
  ROOF_ROW,
  ROOF_ZOOM,
  SEXTANT_ROW,
  SUB,
  WALL_DOUBLE_ROW,
  WALL_SINGLE_ROW,
  WATER_RATE,
  WATER_STROKE_GLYPHS,
  WaterStroke,
} from '../glyphs/select';
import { cellHashGlsl } from './hash';
import { vegetationGlsl } from './vegetation';

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
uniform float u_wind;             // wind over grass: 1, or 0 with reduced motion
uniform float u_zoom;
uniform int u_seeThrough;         // class ids outlines look through (bitmask)
uniform int u_roadMask;           // carriageway class ids (bitmask)
uniform float u_cellAspect;       // cell height / width, for ridge directions
uniform uint u_hover;             // feature index under the pointer (0 = none)
uniform uint u_selected;          // selected feature index (0 = none)
uniform uint u_highlight[${MAX_HIGHLIGHT}];
uniform int u_highlightCount;
uniform sampler2D u_subClass;     // the cell pass at SUB samples per cell
uniform sampler2D u_subAttr;
uniform sampler2D u_subId;
uniform int u_area[${MAX_CLASSES}];
uniform vec3 u_sun;               // toward the sun (x east, y south), tan(altitude); z <= 0: none
uniform vec2 u_cellMeters;        // a cell's width and height in meters (flat views) // 1 for area classes, which draw sub-cell edges

out vec4 o_glyph;

// This cell's state (picking.ts cellState, plus EDGE_STATE) and the class whose fill is its
// background, set in main before any emit.
float g_state = 0.0;
int g_bg = 0;
// SHADOW_STATE if the cell is in a shadow (glyphs/select.ts inShadow), whatever it draws.
float g_shadow = 0.0;
// A vegetation cell's wind level (windLevel) and tone (Tone), which the glyph pass lights and tints.
int g_wind = 0;
int g_tone = 0;

void emit(float glyph, int cls) {
  float state = g_state + g_shadow + float((g_wind << ${WIND_SHIFT}) + (g_tone << ${TONE_SHIFT}));
  o_glyph = vec4(glyph, float(cls) / 255.0, state / 255.0, float(g_bg) / 255.0);
}

int classAt(ivec2 p) {
  p = clamp(p, ivec2(0), textureSize(u_class, 0) - 1);
  return int(texelFetch(u_class, p, 0).r * 255.0 + 0.5);
}

${cellHashGlsl}
${vegetationGlsl}

vec4 idAt(ivec2 p) {
  p = clamp(p, ivec2(0), textureSize(u_id, 0) - 1);
  return texelFetch(u_id, p, 0);
}

uint unpackId(vec4 id) {
  uvec4 b = uvec4(id * 255.0 + 0.5);
  return b.r | (b.g << 8u) | (b.b << 16u) | (b.a << 24u);
}

// The way toward the sun on the grid (x east, y south), or a fixed northwest at night.
vec2 sunDir() {
  return u_sun.z > 0.0 ? normalize(u_sun.xy) : vec2(${float(DEFAULT_SUN[0])}, ${float(DEFAULT_SUN[1])});
}

// A feature's highlight state (picking.ts cellState).
float stateOf(uint fid) {
  if (fid == 0u) return 0.0;
  if (fid == u_selected) return ${CellState.selected}.0;
  for (int i = 0; i < ${MAX_HIGHLIGHT}; i++) {
    if (i >= u_highlightCount) break;
    if (u_highlight[i] == fid) return ${CellState.highlight}.0;
  }
  return fid == u_hover ? ${CellState.hover}.0 : 0.0;
}

// The class whose fill shows under a cell: its own, except carriageways drawn as 1-cell lines.
int fillClass(int cls) {
  bool line = ((u_roadMask >> cls) & 1) == 1 && u_zoom < ${float(ROAD_AREA_ZOOM)};
  return line ? 0 : cls;
}

// The wall row a feature's outline uses at this zoom, or -1 (glyphs/select.ts wallStyle).
int wallRowFor(int kind, vec4 attr) {
  int flags = int(attr.g * 255.0 + 0.5);
  if ((flags & ${Flags.landmark}) != 0 && u_zoom >= ${float(OUTLINE_ZOOM.landmark)}) {
    return kind == ${kindCodes.building} ? ${WALL_DOUBLE_ROW} : ${WALL_SINGLE_ROW};
  }
  // Grounds (no height) are never outlined.
  if (kind == ${kindCodes.building} && attr.r > 0.0 && u_zoom >= ${float(OUTLINE_ZOOM.building)}) {
    return ${WALL_SINGLE_ROW};
  }
  return -1;
}

bool isArea(int c) {
  return u_area[c] == 1;
}

bool isBuilding(int c) {
  return u_kind[c] == ${kindCodes.building};
}

int subClassAt(ivec2 q) {
  return int(texelFetch(u_subClass, q, 0).r * 255.0 + 0.5);
}

// Sub-cell edge (glyphs/select.ts subcellEdge): emits the sextant and returns true, or returns
// false if the cell keeps its glyph. cls is the cell's class (0 for none), id its feature.
bool subcellEdge(ivec2 p, int cls, vec4 id) {
  ivec2 base = p * ivec2(${SUB.cols}, ${SUB.rows});
  int fg = isArea(cls) ? cls : 0;
  vec4 fgId = id;
  vec4 fgAttr = texelFetch(u_attr, p, 0);
  for (int i = 0; i < ${SUB.cols * SUB.rows}; i++) {
    ivec2 q = base + ivec2(i % ${SUB.cols}, i / ${SUB.cols});
    int c = subClassAt(q);
    // A building (with a height, not grounds) wins over the area it stands in.
    bool standing = isBuilding(c) && texelFetch(u_subAttr, q, 0).r > 0.0;
    if (isArea(c) && (fg == 0 || (!(isBuilding(fg) && fgAttr.r > 0.0) && standing))) {
      fg = c;
      fgId = texelFetch(u_subId, q, 0);
      fgAttr = texelFetch(u_subAttr, q, 0);
    }
  }
  if (fg == 0 || wallRowFor(u_kind[fg], fgAttr) >= 0) return false;
  int mask = 0;
  int bg = 0;
  for (int i = 0; i < ${SUB.cols * SUB.rows}; i++) {
    ivec2 q = base + ivec2(i % ${SUB.cols}, i / ${SUB.cols});
    if (texelFetch(u_subId, q, 0) == fgId) mask |= 1 << i;
    else if (bg == 0) bg = subClassAt(q);
  }
  if (mask == 0 || mask == 63) return false;
  g_state = stateOf(unpackId(fgId)) + ${EDGE_STATE}.0;
  g_bg = fillClass(bg);
  emit(texelFetch(u_table, ivec2(mask % 32, ${SEXTANT_ROW} + mask / 32), 0).r, fg);
  return true;
}

// Wall mask (glyphs/select.ts wallMask): -1 inside the feature, else the N/E/S/W join bits.
// A neighbor is outside if it is another feature, unless its class is see-through.
// o[] holds "outside" for the 3x3 neighborhood: 0 NW, 1 N, 2 NE, 3 W, 5 E, 6 SW, 7 S, 8 SE.
// With byRoad, "outside" means any class that is neither a carriageway nor see-through (curbs).
// Wall modes: a feature's outline, or a carriageway's curbs.
const int OUTLINE = 0;
const int CURBS = 1;

int wallMask(ivec2 p, int mode) {
  vec4 id = idAt(p);
  bool o[9];
  bool edge = false;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      ivec2 q = p + ivec2(dx, dy);
      int c = classAt(q);
      bool seeThrough = ((u_seeThrough >> c) & 1) == 1;
      bool outside = mode == CURBS
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

bool isWater(ivec2 p) {
  return u_kind[classAt(p)] == ${kindCodes.water};
}

// Thin water drawn as a stroke (glyphs/select.ts waterStrokeVariant), or -1 to animate.
int waterStroke(ivec2 p, ivec2 w) {
  bool horizontal = isWater(p + ivec2(1, 0)) || isWater(p + ivec2(-1, 0));
  bool vertical = isWater(p + ivec2(0, -1)) || isWater(p + ivec2(0, 1));
  if (vertical && !horizontal) return ${WaterStroke.vertical} + imod(w.y, 2);
  if (vertical || horizontal) return -1;
  if (isWater(p + ivec2(1, -1)) || isWater(p + ivec2(-1, 1))) return ${WaterStroke.rising};
  if (isWater(p + ivec2(-1, -1)) || isWater(p + ivec2(1, 1))) return ${WaterStroke.falling};
  return -1;
}

// The height standing in a cell that casts a shadow: buildings, trees and their crowns (not
// terrain, whose height byte is its band).
float castsAt(ivec2 q) {
  q = clamp(q, ivec2(0), textureSize(u_class, 0) - 1);
  int k = u_kind[classAt(q)];
  bool standing = k == ${kindCodes.building} || k == ${kindCodes.foliage} || k == ${kindCodes.variant};
  return standing ? texelFetch(u_attr, q, 0).r * 255.0 : 0.0;
}

// Whether the cell is in shadow (glyphs/select.ts inShadow): looking toward the sun a cell
// width at a time, something stands taller than the sun rises over that distance.
bool inShadow(ivec2 p) {
  if (u_sun.z <= 0.0) return false;
  float self = castsAt(p);
  vec2 perStep = u_sun.xy * u_cellMeters.x / u_cellMeters;
  for (int k = 1; k <= ${SHADOW.steps}; k++) {
    ivec2 q = p + ivec2(floor(perStep * float(k) + 0.5));
    float h = castsAt(q);
    if (h > 0.0 && h - self >= float(k) * u_cellMeters.x * u_sun.z) return true;
  }
  return false;
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int cls = classAt(p);
  int kind = u_kind[cls];
  g_shadow = inShadow(p) ? ${SHADOW_STATE}.0 : 0.0;
  if (cls == 0 || kind == 0) {
    // An empty cell may still hold part of an area's edge, or a shadow on the ground.
    if (!subcellEdge(p, 0, vec4(0.0))) o_glyph = vec4(0.0, 0.0, g_shadow / 255.0, 0.0);
    return;
  }
  vec4 id = idAt(p);
  g_state = stateOf(unpackId(id));
  g_bg = fillClass(cls);

  ivec2 w = u_origin + p;
  vec4 attr = texelFetch(u_attr, p, 0);
  int variant = int(attr.b * 255.0 + 0.5);

  // Carriageways at Place level: strips with curbs, blank road surface inside.
  if (((u_roadMask >> cls) & 1) == 1 && u_zoom >= ${float(ROAD_AREA_ZOOM)}) {
    int curb = wallMask(p, CURBS);
    float glyph = curb >= 0 ? texelFetch(u_table, ivec2(curb, ${WALL_SINGLE_ROW}), 0).r : 0.0;
    emit(glyph, cls);
    return;
  }

  // Outlines at close zoom (glyphs/select.ts wallStyle).
  int wallRow = wallRowFor(kind, attr);
  if (wallRow >= 0) {
    int mask = wallMask(p, OUTLINE);
    if (mask >= 0) {
      float wall = texelFetch(u_table, ivec2(mask, wallRow), 0).r;
      emit(wall, cls);
      return;
    }
  }

  // Areas' edges at a sixth of a cell.
  if (isArea(cls) && subcellEdge(p, cls, id)) return;

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
    int stroke = u_count[cls] >= ${WATER_STROKE_GLYPHS} ? waterStroke(p, w) : -1;
    if (stroke >= 0) {
      v = stroke;
    } else {
      // A gust ruffles the water in its bands (glyphs/select.ts waterVariant); else each cell
      // flips on its own.
      float gust = u_wind > 0.0 ? u_wind * windGust(w, u_time) : 0.0;
      uint h = cellHash(w);
      float phase = float((h >> 8u) & 255u) / 255.0;
      v = gust >= ${float(GUST_STEPS[0])} ? (gust >= ${float(GUST_STEPS[1])} ? 0 : 1)
        : int((h + uint(floor(u_time * ${float(WATER_RATE)} + phase))) & 1u);
    }
  } else if (kind == ${kindCodes.building}) {
    float height = attr.r * 255.0;
    v = ${BUILDING_STEPS.map((limit, i) => `height < ${float(limit)} ? ${i} : `).join('')}${BUILDING_STEPS.length};
    // Roofs from above (glyphs/select.ts roofVariant): the ridge, and lit and shaded slopes;
    // flat roofs are solid. The ridge angle is in the variant byte.
    if (height > 0.0 && u_zoom >= ${float(ROOF_ZOOM)}) {
      int roof = int(attr.a * 255.0 + 0.5);
      if (roof == ${RoofCode.ridge}) {
        float theta = float(variant) / 255.0 * ${Math.PI};
        float phi = atan(sin(theta) / u_cellAspect, cos(theta));
        int bin = int(floor(phi / ${Math.PI / 4} + 0.5)) % 4;
        float ridge = texelFetch(u_table, ivec2(${RIDGE_VARIANT} + bin, ${ROOF_ROW}), 0).r;
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
  } else if (kind == ${kindCodes.grass}) {
    // Wind (glyphs/select.ts grassCell): tufts at rest, tinted by patch; blades lean and lighten
    // by wind level in a gust and lift again in its wake.
    vec2 front = u_wind > 0.0 ? u_wind * windFront(w, u_time) : vec2(0.0);
    int tone;
    v = min(grassVariant(w, front.x, tone), u_count[cls] - 1);
    g_tone = tone;
    g_wind = windLevel(front.x, front.y);
  } else if (kind == ${kindCodes.crop}) {
    // Fields in the wind (glyphs/select.ts cropVariant); ripe patches are straw.
    vec2 front = u_wind > 0.0 ? u_wind * windFront(w, u_time) : vec2(0.0);
    v = min(cropVariant(w, front.x), u_count[cls] - 1);
    g_tone = cropTone(w);
    g_wind = windLevel(front.x, front.y);
  } else if (kind == ${kindCodes.canopy}) {
    // Woods in the wind (glyphs/select.ts canopyCell): crowns creep downwind and flutter; their
    // sunny side is lit and the far side shaded.
    float gust = u_wind > 0.0 ? u_wind * treeGust(w, u_time) : 0.0;
    int tone;
    v = min(canopyVariant(w, variant, gust, u_time, sunDir(), tone), u_count[cls] - 1);
    g_tone = tone;
  } else if (kind == ${kindCodes.foliage}) {
    // Crown lighting is applied across its rounded surface in the glyph pass.
    float gust = u_wind > 0.0 ? u_wind * treeGust(w, u_time) : 0.0;
    bool rim = classAt(p + ivec2(1, 0)) != cls || classAt(p + ivec2(-1, 0)) != cls
      || classAt(p + ivec2(0, 1)) != cls || classAt(p + ivec2(0, -1)) != cls;
    v = min(foliageVariant(w, u_time, gust, rim), u_count[cls] - 1);
    g_tone = crownIsDry(unpackId(id)) ? ${Tone.dry} : ${Tone.none};
  }
  float glyph = texelFetch(u_table, ivec2(v, cls), 0).r;
  emit(glyph, cls);
}
`;
