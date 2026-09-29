/**
 * Glyph pass: full-resolution draw. Each pixel finds its cell (the grid is shifted by the
 * sub-cell pan offset, so panning scrolls smoothly), reads the cell's glyph and class, samples
 * the glyph atlas, and tints it with the class color over the cell's background (the faint fill
 * of the class the select pass names, SPEC.md §4 "Two colors per cell"). Hovered cells are
 * brighter; highlighted and selected ones take the accent color, the selection with a slow
 * shimmer (SPEC.md §4 "Hover and selection").
 *
 * The life layer (SPEC.md §4 "Life layer") draws on top of the map: an agent shows where the
 * map class under it allows (life/config.ts `cellBits`). The time of day tints everything:
 * night dims the map toward blue, lights some building cells as windows (tilted, only walls)
 * and major roads with streetlights, and turns on vehicles' head- and taillights; dusk warms it.
 * Vehicles take their colors from their paint and the part each cell shows.
 */
import { Flags, MAX_CLASSES } from '../classes';
import { CellBit } from '../life/config';
import { CANDLE_BYTE } from '../life/draw';
import { PAINT_COUNT, VehiclePart } from '../life/vehicles';
import {
  EDGE_INK,
  EDGE_STATE,
  SHADOW,
  SHADOW_STATE,
  WIND_LIGHT,
  WIND_STATE,
} from '../glyphs/select';
import { CellState } from '../picking';
import { RAIN } from '../life/wind';
import { cellHashGlsl } from './hash';

const float = (n: number) => (Number.isInteger(n) ? `${n}.0` : `${n}`);

export const glyphFragment = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D u_glyphs;       // select pass output: glyph index, class id
uniform sampler2D u_atlas;        // R8 glyph coverage
uniform vec2 u_cell;              // cell size in device pixels
uniform vec2 u_shift;             // screen pixel + shift = pixel in the cell grid
uniform float u_height;           // canvas height in device pixels
uniform int u_columns;            // glyph slots per atlas row
uniform vec3 u_colors[${MAX_CLASSES}];
uniform float u_fills[${MAX_CLASSES}]; // background fill strength per class (0 = none)
uniform vec3 u_background;
uniform float u_time;
uniform int u_pulse;              // class id that pulses (landmarks)
uniform sampler2D u_overlay;      // RGBA8, label grid: glyph code (lo, hi; 0 none, 1 blank)
uniform sampler2D u_labelAtlas;   // R8 label text coverage
uniform vec2 u_labelCell;         // label cell size in device pixels
uniform vec2 u_labelShift;        // screen pixel + shift = pixel in the label grid
uniform int u_labelColumns;       // glyph slots per label atlas row
uniform vec3 u_labelColor;
uniform vec3 u_accent;            // highlighted and selected features
uniform bool u_shimmer;           // off with reduced motion
uniform sampler2D u_life;         // RGBA8: glyph index, life class id, agent kind bits (0 none),
                                  // vehicles' paint (low 4 bits) and part (high 4)
uniform int u_cellBits[${MAX_CLASSES}]; // per map class: CellBit set
uniform ivec2 u_origin;           // world cell of texel (0, 0), for window hashes (flat views)
uniform bool u_tilted;            // perspective camera: windows by the cell pass's window key
uniform sampler2D u_attr;         // cell pass attributes (flags; walls' window key)
uniform float u_daylight;         // 0 night – 1 day
uniform int u_vehicle;            // the vehicles' class id (paints, lights)
uniform int u_boat;               // the boats' class id (paints, lights)
uniform int u_person;             // the people's class id (candles)
uniform vec3 u_paints[${PAINT_COUNT}];   // vehicle paints (theme.ts vehiclePaints)
uniform float u_rain;             // how hard it rains, 0–1 (life/wind.ts RAIN)
uniform float u_rainSlant;        // columns a drop drifts per two rows (the wind's x)
uniform int u_rainGlyph;          // the rain glyph's atlas index
uniform vec3 u_rainColor;

out vec4 o_color;

${cellHashGlsl}

// How dark it is: none until well into twilight, so dusk reads warm rather than dim.
float darkness() {
  return smoothstep(0.3, 1.0, 1.0 - u_daylight);
}

// The time of day: dim and blue at night, warm at dusk.
vec3 daylit(vec3 color) {
  float dusk = 1.0 - abs(u_daylight - 0.5) * 2.0;
  color = mix(color, color * vec3(1.2, 0.88, 0.68), dusk * 0.45);
  return mix(color, color * vec3(0.4, 0.48, 0.78), darkness() * 0.85);
}

// A class's fill in a color: the background tinted toward it by the class's fill strength.
vec3 fillOf(int cls, vec3 color) {
  return mix(u_background, color, u_fills[cls]);
}

// How much lamps and candles shine: from dusk, fully at night.
float lamps() {
  return smoothstep(0.25, 0.8, 1.0 - u_daylight);
}

// A vehicle or boat cell's color: its paint, shaded by the part it shows (life/vehicles.ts). At
// night, head- and taillights shine, and a one-glyph vehicle glows whole, unless it is parked.
vec3 vehicleColor(int byte, float night) {
  int index = byte & 15;
  int part = (byte >> 4) & 7;
  // How much its lamps shine: at night, unless it is parked.
  float lit = (byte & 128) != 0 ? 0.0 : lamps();
  vec3 paint = u_paints[min(index, ${PAINT_COUNT - 1})];
  if (part == ${VehiclePart.roof}) paint *= 0.8;
  else if (part == ${VehiclePart.glass}) paint = mix(paint, vec3(0.14, 0.2, 0.28), 0.75);
  else if (part == ${VehiclePart.trim}) paint = mix(paint, vec3(0.12), 0.7);
  else if (part == ${VehiclePart.accent}) paint = u_paints[(index + 7) % ${PAINT_COUNT}];
  // Streetlights and their own lamps keep moving vehicles from sinking into the night.
  vec3 color = mix(daylit(paint), paint * 0.7, lit * 0.5);
  if (part == ${VehiclePart.headlight}) {
    return mix(daylit(mix(paint, vec3(1.0, 0.97, 0.86), 0.6)), vec3(1.0, 0.93, 0.7), lit);
  }
  if (part == ${VehiclePart.taillight}) {
    return mix(daylit(vec3(0.78, 0.14, 0.1)), vec3(1.0, 0.22, 0.14), lit);
  }
  if (part == ${VehiclePart.mini}) return mix(color, vec3(1.0, 0.95, 0.8), lit * 0.7);
  return color;
}

int imodRain(int a, int n) {
  return ((a % n) + n) % n;
}

// Rain over the map (life/wind.ts rainDrop): the map dims, and drops fall down the screen,
// drifting with the wind.
vec3 rainOver(vec3 color, ivec2 cell, ivec2 inCell) {
  if (u_rain <= 0.0) return color;
  color = mix(color, color * 0.75 + vec3(0.01, 0.02, 0.04), u_rain * ${float(RAIN.dim)} / 0.25);
  ivec2 w = u_origin + cell;
  int row = imodRain(w.y, ${RAIN.wrap});
  int column = w.x - int(floor(float(row) * u_rainSlant * 0.5 + 0.5));
  uint h = cellHash(ivec2(column, 7919));
  if (float((h >> 8u) & 255u) >= ${float(RAIN.density)} * u_rain * 256.0) return color;
  float along = float(row) - u_time * ${float(RAIN.speed)} + float(h & 1023u);
  if (mod(along, ${float(RAIN.spacing)}) >= ${float(RAIN.length)}) return color;
  ivec2 slot = ivec2(u_rainGlyph % u_columns, u_rainGlyph / u_columns) * ivec2(u_cell);
  float ink = texelFetch(u_atlas, slot + inCell, 0).r;
  return mix(color, u_rainColor, ink * ${float(RAIN.ink)} * u_rain);
}

void main() {
  vec2 screen = vec2(gl_FragCoord.x, u_height - gl_FragCoord.y);
  vec2 grid = screen + u_shift;
  ivec2 cell = ivec2(floor(grid / u_cell));
  ivec2 inCell = ivec2(grid - vec2(cell) * u_cell);

  // Labels sit on top, on their own coarser grid (density.ts); their cells show the
  // background, which gives them a halo.
  vec2 labelGrid = screen + u_labelShift;
  ivec2 labelCell = ivec2(floor(labelGrid / u_labelCell));
  vec4 over = texelFetch(u_overlay, labelCell, 0);
  int code = int(over.r * 255.0 + 0.5) + 256 * int(over.g * 255.0 + 0.5);
  if (code > 0) {
    int index = code - 1;
    ivec2 at = ivec2(index % u_labelColumns, index / u_labelColumns) * ivec2(u_labelCell);
    ivec2 inLabel = ivec2(labelGrid - vec2(labelCell) * u_labelCell);
    float ink = texelFetch(u_labelAtlas, at + inLabel, 0).r;
    o_color = vec4(mix(u_background, u_labelColor, ink), 1.0);
    return;
  }

  vec4 g = texelFetch(u_glyphs, cell, 0);
  int cls = int(g.g * 255.0 + 0.5);
  int rawState = int(g.b * 255.0 + 0.5);
  bool edge = (rawState & ${EDGE_STATE}) != 0;
  bool windLit = (rawState & ${WIND_STATE}) != 0;
  bool shaded = (rawState & ${SHADOW_STATE}) != 0;
  int state = rawState & ${EDGE_STATE - 1};
  int bgClass = int(g.a * 255.0 + 0.5);
  float night = darkness();
  // The cell's background: its fill class's color, faint (theme.ts ClassStyle.fill).
  vec3 back = fillOf(bgClass, daylit(u_colors[bgClass]));
  // A shadow darkens the ground and whatever stands in it (glyphs/select.ts SHADOW).
  float shade = shaded ? 1.0 - ${float(SHADOW.dark)} : 1.0;
  back *= shade;

  // Agents stand on top where the cell under them allows.
  vec4 life = texelFetch(u_life, cell, 0);
  int lifeBit = int(life.b * 255.0 + 0.5);
  if (lifeBit != 0 && (u_cellBits[cls] & lifeBit) != 0) {
    int lifeGlyph = int(life.r * 255.0 + 0.5);
    int lifeClass = int(life.g * 255.0 + 0.5);
    ivec2 slot = ivec2(lifeGlyph % u_columns, lifeGlyph / u_columns) * ivec2(u_cell);
    float coverage = texelFetch(u_atlas, slot + inCell, 0).r;
    int lifeByte = int(life.a * 255.0 + 0.5);
    bool painted = lifeClass == u_vehicle || lifeClass == u_boat;
    vec3 color = painted ? vehicleColor(lifeByte, night) : daylit(u_colors[lifeClass]);
    if (lifeClass == u_person && lifeByte == ${CANDLE_BYTE}) {
      // A candle, from dusk: warm, each flickering on its own beat.
      float beat = float(cellHash(u_origin + cell) & 7u) + 3.0;
      float flicker = u_shimmer ? 0.85 + 0.15 * sin(u_time * beat) : 1.0;
      color = mix(color, vec3(1.0, 0.78, 0.4) * flicker, lamps());
    }
    o_color = vec4(rainOver(mix(back, color, coverage), cell, inCell), 1.0);
    return;
  }

  if (cls == 0) {
    o_color = vec4(rainOver(back, cell, inCell), 1.0);
    return;
  }
  int glyph = int(g.r * 255.0 + 0.5);
  ivec2 slot = ivec2(glyph % u_columns, glyph / u_columns) * ivec2(u_cell);
  float coverage = texelFetch(u_atlas, slot + inCell, 0).r;
  vec3 color = daylit(u_colors[cls]);
  if (cls == u_pulse) color *= 0.7 + 0.3 * sin(u_time * 3.0);
  int bits = u_cellBits[cls];
  if ((bits & ${CellBit.streetlight}) != 0) color = mix(color, vec3(1.0, 0.78, 0.45), night * 0.4);
  if ((bits & ${CellBit.window}) != 0 && night > 0.0) {
    // More windows light up as the night deepens; each flickers a little on its own beat.
    // Flat views hash the world cell. Tilted, the grid is fixed to the screen, so windows go by
    // the patch of wall the cell shows (cell.ts window key); roofs have none.
    uint h = cellHash(u_origin + cell);
    if (u_tilted) {
      vec4 attr = texelFetch(u_attr, cell, 0);
      int flags = int(attr.g * 255.0 + 0.5);
      bool wall = (flags & ${Flags.extruded}) != 0 && (flags & ${Flags.roof}) == 0;
      h = wall ? cellHash(ivec2(int(attr.a * 255.0 + 0.5), 0)) : 0xffffffffu;
    }
    if (float((h >> 4u) & 255u) / 255.0 < night * 0.12) {
      float beat = float((h >> 12u) & 7u) + 1.0;
      float flicker = u_shimmer ? 0.88 + 0.12 * sin(u_time * beat * 0.7) : 1.0;
      color = mix(color, vec3(1.0, 0.82, 0.48) * flicker, 0.85);
    }
  }
  // Blades and leaves caught by a gust show their pale sides (glyphs/select.ts WIND_STATE).
  if (windLit) color = mix(color, vec3(1.0), ${WIND_LIGHT});
  if (state == ${CellState.hover}) {
    color = mix(color, vec3(1.0), 0.45);
  } else if (state == ${CellState.highlight}) {
    color = u_accent;
  } else if (state == ${CellState.selected}) {
    color = u_accent;
    if (u_shimmer) color *= 0.78 + 0.22 * sin(u_time * 2.5 - float(cell.x + cell.y) * 0.35);
  }
  // The feature's own fill takes its highlight too, so a selected footprint lights up whole.
  if (!edge && bgClass == cls) back = fillOf(cls, color) * shade;
  // A sub-cell edge draws the feature's part in a tone between its fill and its glyphs, so the
  // shape reads as one area with a crisp rim.
  if (edge) color = mix(fillOf(cls, color), color, ${EDGE_INK});
  color *= shade;
  o_color = vec4(rainOver(mix(back, color, coverage), cell, inCell), 1.0);
}
`;
