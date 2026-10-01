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
import {
  classId,
  Flags,
  Marking,
  MAX_CLASSES,
  PavingVariant,
  pavingOverrideBase,
} from '../classes';
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
  ARROW_VARIANT,
  RISING,
  ROAD_AREA_ZOOM,
  RoofCode,
  ROOF_ROW,
  ROOF_ZOOM,
  SEXTANT_ROW,
  SUB,
  WALL_DOUBLE_ROW,
  WALL_SINGLE_ROW,
  WATER_RIPPLE,
  WATER_STROKE_GLYPHS,
  WaterStroke,
} from '../glyphs/select';
import { cellHashGlsl } from './hash';
import { vegetationGlsl } from './vegetation';
import { partyWallsGlsl } from './party-walls';

const float = (n: number) => (Number.isInteger(n) ? `${n}.0` : `${n}`);

export const selectFragment = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D u_class;
uniform sampler2D u_attr;
uniform sampler2D u_id;           // packed feature ids
uniform sampler2D u_baseClass;    // underlying geometry before animated crowns
uniform sampler2D u_baseAttr;
uniform sampler2D u_baseId;
uniform sampler2D u_table;        // MAX_VARIANTS x MAX_CLASSES glyph indices (+ wall rows)
uniform int u_kind[${MAX_CLASSES}];
uniform int u_count[${MAX_CLASSES}];
uniform int u_connect[${MAX_CLASSES}];
uniform ivec2 u_origin;           // world cell of texel (0, 0)
uniform float u_time;             // seconds; 0 with reduced motion
uniform float u_wind;             // wind over grass: 1, or 0 with reduced motion
uniform float u_zoom;
uniform bool u_shadows;
uniform bool u_awnings;
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

void emit(vec2 glyph, int cls) {
  float state = g_state + g_shadow + float((g_wind << ${WIND_SHIFT}) + (g_tone << ${TONE_SHIFT}));
  o_glyph = vec4(glyph.x, float(cls + (int(glyph.y * 255.0 + 0.5) << 6)) / 255.0, state / 255.0, float(g_bg) / 255.0);
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

// Crowns cover geometry, without making new road curbs or roof walls along their rims.
bool crownAt(ivec2 p) { return classAt(p) == ${classId('tree_crown')}; }
int groundClassAt(ivec2 p) {
  p = clamp(p, ivec2(0), textureSize(u_class, 0) - 1);
  int c=classAt(p);
  return c==${classId('tree_crown')} ? int(texelFetch(u_baseClass, p, 0).r * 255.0 + 0.5) : c;
}
vec4 groundAttrAt(ivec2 p) {
  p = clamp(p, ivec2(0), textureSize(u_class, 0) - 1);
  return crownAt(p) ? texelFetch(u_baseAttr, p, 0) : texelFetch(u_attr, p, 0);
}
vec4 groundIdAt(ivec2 p) {
  p = clamp(p, ivec2(0), textureSize(u_class, 0) - 1);
  return crownAt(p) ? texelFetch(u_baseId, p, 0) : idAt(p);
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

int maskBit(int mask, int cls) { return cls < 32 ? ((mask >> cls) & 1) : 0; }

// The class whose fill shows under a cell: its own, except carriageways drawn as 1-cell lines.
int fillClass(int cls) {
  bool line = maskBit(u_roadMask, cls) == 1 && u_zoom < ${float(ROAD_AREA_ZOOM)};
  return line ? 0 : cls;
}

// The wall row a feature's outline uses at this zoom, or -1 (glyphs/select.ts wallStyle).
int wallRowFor(int kind, vec4 attr, int cls) {
  if (cls == ${classId('paving')} && attr.b > 0.0 && u_zoom >= ${float(OUTLINE_ZOOM.building)}) return ${WALL_SINGLE_ROW};
  // Low stone edges keep an outline even when their height rounds to zero in the byte buffer.
  if (kind == ${kindCodes.seating} && u_zoom >= ${float(OUTLINE_ZOOM.building)}) return ${WALL_SINGLE_ROW};
  // Crown gb attributes encode the local surface, rather than feature flags.
  if (kind == ${kindCodes.foliage}) return -1;
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

// CPU twin: glyphs/select.ts edgeForegroundWins.
bool pavingOverride(int c, vec4 attr) {
  return c == ${classId('paving')} && int(attr.b * 255.0 + 0.5) == ${PavingVariant.override};
}
bool belowPavingOverride(int c, vec4 attr) {
  return !pavingOverride(c, attr) && (
    ${pavingOverrideBase.map((cls) => `c == ${classId(cls)}`).join(' || ')} ||
    (isBuilding(c) && attr.r == 0.0)
  );
}
bool edgeForegroundWins(int c, vec4 attr, int fg, vec4 fgAttr) {
  bool crown = c == ${classId('tree_crown')};
  bool underCrown = fg == ${classId('tree_crown')};
  bool standing = isBuilding(c) && attr.r > 0.0;
  bool underRoof = isBuilding(fg) && fgAttr.r > 0.0;
  if (crown && (underRoof || underCrown)) return attr.r > fgAttr.r;
  if (underCrown && standing) return attr.r >= fgAttr.r;
  if (pavingOverride(c, attr)) return belowPavingOverride(fg, fgAttr);
  if (pavingOverride(fg, fgAttr)) return c != 0 && !belowPavingOverride(c, attr);
  return crown || (!underRoof && standing);
}

int subClassAt(ivec2 q) {
  return int(texelFetch(u_subClass, q, 0).r * 255.0 + 0.5);
}

// Sub-cell edge (glyphs/select.ts subcellEdge): emits the sextant and returns true, or returns
// false if the cell keeps its glyph. cls is the cell's class (0 for none), id its feature.
bool subcellEdge(ivec2 p, int cls, vec4 id) {
  ivec2 base = p * ivec2(${SUB.cols}, ${SUB.rows});
  vec4 centerAttr = texelFetch(u_attr, p, 0);
  // Non-area ground (terrain) participates only beside an opt-in paving surface.
  // Keep its legacy edge behavior when no override reaches this cell.
  if (cls != 0 && !isArea(cls) && maskBit(u_roadMask, cls) == 0) {
    bool adjacentOverride = false;
    if (belowPavingOverride(cls, centerAttr)) {
      for (int i = 0; i < ${SUB.cols * SUB.rows}; i++) {
        ivec2 q = base + ivec2(i % ${SUB.cols}, i / ${SUB.cols});
        if (pavingOverride(subClassAt(q), texelFetch(u_subAttr, q, 0))) adjacentOverride = true;
      }
    }
    if (!adjacentOverride) return false;
  }
  int fg = isArea(cls) ? cls : 0;
  vec4 fgId = id;
  vec4 fgAttr = centerAttr;
  for (int i = 0; i < ${SUB.cols * SUB.rows}; i++) {
    ivec2 q = base + ivec2(i % ${SUB.cols}, i / ${SUB.cols});
    int c = subClassAt(q);
    vec4 sampleAttr = texelFetch(u_subAttr, q, 0);
    if (cls != 0 && !isArea(cls) && c != ${classId('tree_crown')} &&
        !(belowPavingOverride(cls, centerAttr) && pavingOverride(c, sampleAttr))) continue;
    if (isArea(c) && (fg == 0 || edgeForegroundWins(c, sampleAttr, fg, fgAttr))) {
      fg = c;
      fgId = texelFetch(u_subId, q, 0);
      fgAttr = sampleAttr;
    }
  }
  if (fg == 0 || wallRowFor(u_kind[fg], fgAttr, fg) >= 0) return false;
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
  emit(texelFetch(u_table, ivec2(mask % 32, ${SEXTANT_ROW} + mask / 32), 0).rg, fg);
  return true;
}

// Wall mask (glyphs/select.ts wallMask): -1 inside the feature, else the N/E/S/W join bits.
// A neighbor is outside if it is another feature, unless its class is see-through.
// o[] holds "outside" for the 3x3 neighborhood: 0 NW, 1 N, 2 NE, 3 W, 5 E, 6 SW, 7 S, 8 SE.
// With byRoad, "outside" means any class that is neither a carriageway nor see-through (curbs).
// Wall modes: a feature's outline, or a carriageway's curbs.
int awningSide(ivec2 p, vec4 id) {
  for (int side = 0; side < 4; side++) {
    ivec2 dir = side == 0 ? ivec2(0, -1) : side == 1 ? ivec2(1, 0) : side == 2 ? ivec2(0, 1) : ivec2(-1, 0);
    if (idAt(p + dir) == id) continue;
    for (int step = 1; step <= 3; step++) {
      int c = classAt(p + dir * step);
      if (maskBit(u_roadMask, c) != 0 || c == ${classId('path')}) return side;
      if (u_kind[c] == ${kindCodes.building} || u_kind[c] == ${kindCodes.water}) break;
    }
  }
  return -1;
}

const int OUTLINE = 0;
const int CURBS = 1;

${partyWallsGlsl}

int wallMask(ivec2 p, int mode) {
  if (mode == OUTLINE) {
    int party = partyWallMask(p);
    if (party != -2) return party;
  }
  vec4 id = groundIdAt(p);
  bool o[9];
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      ivec2 q = p + ivec2(dx, dy);
      int i=(dy+2)*5+dx+2;
      bool outside;
      if (mode==OUTLINE && partyCached3) {
        uint neighbor=partyRoof[i] ? partyIds[i] : unpackId(groundIdAt(q));
        outside=neighbor!=unpackId(id) && !partyThrough[i];
      } else {
        int c = groundClassAt(q);
        bool seeThrough = maskBit(u_seeThrough, c) == 1;
        if (mode==CURBS) {
          bool sidewalk=(int(groundAttrAt(q).g*255.0+0.5) & ${Flags.sidewalk}) != 0;
          outside=sidewalk || (maskBit(u_roadMask,c)==0 && !seeThrough);
        } else outside=groundIdAt(q)!=id && !seeThrough;
      }
      o[(dy + 1) * 3 + dx + 1] = outside;
    }
  }
  return joinMask(o);
}

int imod(int a, int n) {
  return ((a % n) + n) % n;
}

bool joins(int mask, ivec2 p) {
  int c = (mask & u_roadMask) != 0 ? groundClassAt(p) : classAt(p);
  return maskBit(mask, c) == 1;
}

bool isWater(ivec2 p) {
  return u_kind[classAt(p)] == ${kindCodes.water};
}

// Open water's drifting crests (glyphs/select.ts waterVariant).
int waterRipple(ivec2 w) {
  int period = ${WATER_RIPPLE.period};
  uint row = cellHash(ivec2(w.y, ${WATER_RIPPLE.salt}));
  float speed = (row & 1u) == 0u ? ${float(WATER_RIPPLE.speeds[0])} : ${float(WATER_RIPPLE.speeds[1])};
  int shifted = w.x + int((row >> 8u) % uint(period));
  int base = imod(shifted, period);
  float pos = float(base) - u_time * speed;
  float cycles = floor(pos / float(period));
  float along = pos - cycles * float(period);
  int slot = (shifted - base) / period + int(cycles);
  return along < ${float(WATER_RIPPLE.crest)} && (cellHash(ivec2(slot, w.y)) & 3u) != 0u ? 1 : 0;
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
  if (!u_shadows || u_sun.z <= 0.0) return false;
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

  // Test crown edges before road curbs and roof walls, including centers outside the crown.
  if ((maskBit(u_roadMask, cls) == 1 || isBuilding(cls) || belowPavingOverride(cls, attr)) && subcellEdge(p, cls, id)) return;

  // Carriageways at Place level: strips with curbs, blank road surface inside.
  if (maskBit(u_roadMask, cls) == 1 && u_zoom >= ${float(ROAD_AREA_ZOOM)}) {
    int curb = wallMask(p, CURBS);
    vec2 glyph = curb >= 0 ? texelFetch(u_table, ivec2(curb, ${WALL_SINGLE_ROW}), 0).rg : vec2(0.0);
    if (curb < 0 && (int(attr.g * 255.0 + 0.5) & ${Flags.crossing}) != 0) {
      int axis = variant & 31;
      bool vertical = axis < 8 || axis >= 24;
      int marking = variant >> 6;
      if (marking == ${Marking.crosswalk}) {
        int parity = vertical ? w.y : w.x;
        bool stripe = min(u_cellMeters.x, u_cellMeters.y) >= 1.2 || (parity & 1) == 0;
        glyph = stripe ? texelFetch(u_table, ivec2(vertical ? 10 : 5, ${WALL_DOUBLE_ROW}), 0).rg : vec2(0.0);
      } else if (marking == ${Marking.stop}) {
        glyph = texelFetch(u_table, ivec2(vertical ? 10 : 5, ${WALL_SINGLE_ROW}), 0).rg;
      } else if (marking == ${Marking.arrow}) {
        float theta = float(variant & 63) * ${(2 * Math.PI) / 64};
        float angle = atan(sin(theta), cos(theta) / u_cellAspect);
        int bin = imod(int(floor(angle / ${Math.PI / 4} + 0.5)), 8);
        glyph = texelFetch(u_table, ivec2(${ARROW_VARIANT} + bin, ${ROOF_ROW}), 0).rg;
      }
    }
    emit(glyph, cls);
    return;
  }

  // Outlines at close zoom (glyphs/select.ts wallStyle).
  int wallRow = wallRowFor(kind, attr, cls);
  if (wallRow >= 0) {
    int mask = wallMask(p, OUTLINE);
    if (mask >= 0) {
      int flags = int(attr.g * 255.0 + 0.5);
      if (u_awnings && kind == ${kindCodes.building} && (flags & ${Flags.frontage}) != 0) {
        int side = awningSide(p, id);
        if (side >= 0) {
          int shape = side == 0 ? 3 : side == 1 ? 42 : side == 2 ? 48 : 21;
          int shopKind = ((flags & ${Flags.frontageLow}) != 0 ? 1 : 0) + ((flags & ${Flags.frontageHigh}) != 0 ? 2 : 0);
          int code = 1 + shopKind * 2 + ((side == 0 || side == 2 ? w.x : w.y) & 1);
          g_wind = code & 3;
          g_tone = code >> 2;
          emit(texelFetch(u_table, ivec2(shape % 32, ${SEXTANT_ROW} + shape / 32), 0).rg, cls);
          return;
        }
      }
      vec2 wall = texelFetch(u_table, ivec2(mask, wallRow), 0).rg;
      emit(wall, cls);
      return;
    }
  }

  // Areas' edges at a sixth of a cell.
  if (isArea(cls) && subcellEdge(p, cls, id)) return;

  int v = 0;
  if ((int(attr.g * 255.0 + 0.5) & ${Flags.sidewalk}) != 0 && u_zoom >= ${float(ROAD_AREA_ZOOM)}) {
    emit(texelFetch(u_table, ivec2(0, ${classId('path')}), 0).rg, cls);
    return;
  }
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
      // A gust ruffles the water in its bands (glyphs/select.ts waterVariant); else its crests drift.
      float gust = u_wind > 0.0 ? u_wind * windGust(w, u_time) : 0.0;
      v = gust >= ${float(GUST_STEPS[0])} ? (gust >= ${float(GUST_STEPS[1])} ? 0 : 1)
        : waterRipple(w);
    }
  } else if (kind == ${kindCodes.building}) {
    float height = attr.r * 255.0;
    v = ${BUILDING_STEPS.map((limit, i) => `height < ${float(limit)} ? ${i} : `).join('')}${BUILDING_STEPS.length};
    if (partySeam(p, cls, attr)) v = max(0, v - 1);
    // Roofs from above (glyphs/select.ts roofVariant): the ridge, and lit and shaded slopes;
    // flat roofs are solid. The ridge angle is in the variant byte.
    if (height > 0.0 && u_zoom >= ${float(ROOF_ZOOM)}) {
      int roof = int(attr.a * 255.0 + 0.5);
      if (roof == ${RoofCode.ridge} || roof == ${RoofCode.hipPos} || roof == ${RoofCode.hipNeg}) {
        float theta = float(variant) / 255.0 * ${Math.PI};
        float phi = atan(sin(theta) / u_cellAspect, cos(theta));
        int bin = int(floor(phi / ${Math.PI / 4} + 0.5)) % 4;
        vec2 ridge = texelFetch(u_table, ivec2(${RIDGE_VARIANT} + bin, ${ROOF_ROW}), 0).rg;
        emit(ridge, cls);
        return;
      }
      // Without a ridge (flat roofs, landmark parts) the height ramp stays.
      if (roof == ${RoofCode.sidePos} || roof == ${RoofCode.sideNeg} || roof == ${RoofCode.endPos} || roof == ${RoofCode.endNeg}) {
        float theta = float(variant) / 255.0 * ${Math.PI};
        vec2 normal = roof == ${RoofCode.endPos} || roof == ${RoofCode.endNeg}
          ? vec2(cos(theta), sin(theta)) : vec2(-sin(theta), cos(theta));
        if (roof == ${RoofCode.sideNeg} || roof == ${RoofCode.endNeg}) normal = -normal;
        float lit = dot(normal, sunDir());
        if (lit > 0.25) v = 2;
        else if (lit < -0.25) v = 1;
      }
    }
  } else if (kind == ${kindCodes.variant}) {
    if (cls == ${classId('furniture')} && variant >= 9 && variant <= 11) {
      int code = 1 + (variant - 9) * 2;
      g_wind = code & 3;
      g_tone = code >> 2;
    }
    v = min(variant, u_count[cls] - 1);
  } else if (kind == ${kindCodes.ramp}) {
    v = clamp(int(attr.r * 255.0 + 0.5) - 1, 0, u_count[cls] - 1);
  } else if (kind == ${kindCodes.diagonal}) {
    v = imod(w.x + w.y, u_count[cls]);
  } else if (kind == ${kindCodes.rows}) {
    v = imod(w.y, u_count[cls]);
  } else if (kind == ${kindCodes.scatter}) {
    v = int(cellHash(w) % uint(u_count[cls]));
  } else if (kind == ${kindCodes.grass} || kind == ${kindCodes.planting}) {
    // Wind (glyphs/select.ts grassCell): tufts at rest, tinted by patch; blades lean and lighten
    // by wind level in a gust and lift again in its wake.
    vec2 front = u_wind > 0.0 ? u_wind * windFront(w, u_time) : vec2(0.0);
    int tone;
    v = min(kind == ${kindCodes.planting} ? plantingVariant(w, front.x, tone) : grassVariant(w, front.x, tone), u_count[cls] - 1);
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
  vec2 glyph = texelFetch(u_table, ivec2(v, cls), 0).rg;
  emit(glyph, cls);
}
`;
