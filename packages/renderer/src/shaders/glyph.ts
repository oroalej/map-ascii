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
 * night dims the map toward blue, lights some building cells as windows,
 * and turns on vehicles' head- and taillights; dusk warms it. From dusk, streetlights along major
 * and secondary roads cast pools of light (life/lights.ts); some are out and some flicker. Zoomed
 * out, those roads read as a lit corridor instead.
 * Vehicles take their colors from their paint and the part each cell shows. The life texture
 * stores glyph, class, kind bits, and paint/part bytes; the overlay stores 16-bit label codes
 * (0 absent, 1 blank). The light texture stores pool strength, lamp state and seed, head, and
 * ownership. Uniform names below describe these inputs; documentation stays outside the
 * GLSL string so it does not add to the shipped shader payload.
 */
import { Flags, MAX_CLASSES } from '../classes';
import { BIRD_ACCENT_BIT, BIRD_SILHOUETTE_BIT, BIRD_SPECIES_ORDER } from '../life/birds';
import { BIRD_SHADOW, CellBit, EVENT_PERSON_BITS, LIFE_SHADOW } from '../life/config';
import { FOCUS_DIM, LIFE_FOCUS_BIT } from '../focus';
import { HELD_CLOCK_BASE, ORDINARY_CLOCK } from '../life/effect-clocks';
import { CANDLE_BIT, PersonPart } from '../life/people';
import { LampState } from '../life/lights';
import { FixturePart, SIGNAL_LIGHT } from '../life/fixtures';
import { PAINT_COUNT, VehiclePart } from '../life/vehicles';
import { LIFE_AGENT_MASK, TURN_SIGNAL_BIT, TURN_SIGNAL_COLOR } from '../life/turn-signals';
import { BRAKE_COLOR, BRAKE_LAMP, BRAKE_GLOW } from '../life/lamps';
import { PUFF_COLOR, PUFF_AGE_MASK, PUFF_KIND_BIT } from '../life/puff-style';
import {
  CROWN_LIGHT,
  EDGE_INK,
  EDGE_STATE,
  SHADOW,
  SHADOW_STATE,
  SUB,
  Tone,
  TONE,
  TONE_SHIFT,
  WIND_LIGHT,
  WIND_SHIFT,
} from '../glyphs/select';
import { CellState } from '../picking';
import { RAIN } from '../life/wind';
import { cellHashGlsl } from './hash';
import { waterEffectGlsl } from '../life/water';
import { buntingMotionGlsl } from '../life/bunting-motion';
import { festivePulseGlsl } from '../life/seasonal-installations';
import { carnivalMotionGlsl } from '../life/carnival-motion';

const float = (n: number) => (Number.isInteger(n) ? `${n}.0` : `${n}`);

/**
 * Lighting helpers: darkness starts after twilight, daylit warms dusk and cools moonlit nights,
 * toned brightens foliage only by day, and fillOf tints each class's background. Lamps fade in
 * through dusk; dead lamps stay off and each flickering lamp has a seeded stutter, while candle
 * light wavers gently. Reduced motion holds these steady. switchedOn staggers streetlights by
 * their seed and brings floodlights on early. reflection traces rippled, fading streaks below
 * bank lamps, excluding vehicle beams. Wet roads strengthen their pools; roofs and water take
 * a fainter wash than open ground.
 */
/** Compile inactive features away instead of branching through them at every pixel. */
export function glyphFragmentFor({ focus = true, effectClocks = true, seasonal = true } = {}) {
  return /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D u_glyphs;
uniform sampler2D u_atlas;
uniform vec2 u_cell;
uniform vec2 u_shift;
uniform float u_height;
uniform int u_columns;
uniform vec3 u_colors[${MAX_CLASSES}];
uniform vec3 u_fillColors[${MAX_CLASSES}];
uniform float u_fills[${MAX_CLASSES}];
uniform vec3 u_background;
uniform float u_time;
uniform float u_lifeTime;
uniform int u_pulse;
uniform sampler2D u_overlay;
uniform sampler2D u_labelAtlas;
uniform vec2 u_labelCell;
uniform vec2 u_labelShift;
uniform int u_labelColumns;
uniform vec3 u_labelColor;
uniform vec3 u_accent;
uniform bool u_shimmer;
uniform float u_buntingWind;
uniform vec2 u_buntingWindDir;
${focus ? 'uniform bool u_focus;\nuniform bool u_focusLife;' : 'const bool u_focus = false;\nconst bool u_focusLife = false;'}
uniform uvec2 u_focusClasses;
uniform sampler2D u_life;
uniform sampler2D u_effectClocks;
${effectClocks ? 'uniform bool u_hasEffectClocks;' : 'const bool u_hasEffectClocks = false;'}
uniform sampler2D u_subClass; // visible surfaces at the canopy's 2 x 3 edge samples
uniform sampler2D u_subAttr;
uniform int u_cellBits[${MAX_CLASSES}];
uniform ivec2 u_origin;
uniform sampler2D u_attr;
uniform int u_crownClass;
uniform vec3 u_crownSun;
uniform float u_daylight;
uniform int u_vehicle;
uniform ivec3 u_vehicleOccluders; // trunks, crowns, and woods cover all non-bird Life
uniform int u_boat;
uniform int u_train;
uniform int u_person;
uniform int u_bird;
uniform vec3 u_birdPaints[${BIRD_SPECIES_ORDER.length * 2}];
uniform vec3 u_paints[${PAINT_COUNT}];
uniform vec3 u_awningPaints[8];
uniform float u_rain;
uniform float u_rainSlant;
uniform int u_rainGlyph;
uniform vec3 u_rainColor;
uniform bool u_waterDetail;
uniform bool u_fish;
uniform ivec2 u_fishWater;
uniform int u_waterGlyphs[4];
uniform sampler2D u_light;
uniform float u_lampShow;
uniform sampler2D u_fixtures;
uniform vec3 u_fixturePaints[11];
uniform bool u_signalGlow;
uniform sampler2D u_signalLight;
uniform float u_dpr;
uniform float u_moon;

out vec4 o_color;

${cellHashGlsl}
${waterEffectGlsl}

float darkness() {
  return smoothstep(0.3, 1.0, 1.0 - u_daylight);
}

vec3 daylit(vec3 color) {
  float dusk = 1.0 - abs(u_daylight - 0.5) * 2.0;
  color = mix(color, color * vec3(1.2, 0.88, 0.68), dusk * 0.45);
  vec3 tint = mix(vec3(0.4, 0.48, 0.78), vec3(0.6, 0.64, 0.76), u_moon);
  return mix(color, color * tint, darkness() * (0.85 - 0.2 * u_moon));
}

vec3 toned(vec3 color, int tone, float night) {
  if (tone == ${Tone.shade}) return color * ${float(TONE.shade)};
  if (tone == ${Tone.light}) return mix(color, vec3(1.0), ${float(TONE.light)} * (1.0 - night));
  if (tone == ${Tone.dry}) return min(color * vec3(${TONE.dry.map(float).join(', ')}), 1.0);
  return color;
}

vec3 fillOf(int cls, vec3 color) {
  vec3 pigment = color * u_fillColors[cls] / max(u_colors[cls], vec3(1.0 / 255.0));
  return mix(u_background, pigment, u_fills[cls]);
}

float lamps() {
  return smoothstep(0.25, 0.8, 1.0 - u_daylight);
}

const vec3 LAMP = vec3(1.0, 0.78, 0.45);

const vec3 LAMP_WHITE = vec3(1.0, 0.9, 0.7);
// A shop's warm interior light, spilling out of its door.
const vec3 SHOP_LIGHT = vec3(1.0, 0.74, 0.42);

float effectTime(ivec2 cell, int channel) {
  if (!u_hasEffectClocks) return u_lifeTime;
  float token = texelFetch(u_effectClocks, cell, 0)[channel];
  if (token == ${float(ORDINARY_CLOCK)}) return u_lifeTime;
  return token <= ${float(HELD_CLOCK_BASE)} ? ${float(HELD_CLOCK_BASE)} - token : u_lifeTime - token;
}

float lampOn(int g, float time) {
  int state = g & 7;
  if (state == ${LampState.dead}) return 0.0;
  if (state == ${LampState.candle}) {
    float beat = 5.0 + float(g >> 3) * 0.23;
    return u_shimmer ? 0.8 + 0.2 * sin(time * beat + float(g >> 3)) : 1.0;
  }
  if (state != ${LampState.flicker} || !u_shimmer) return 1.0; // working, a beam, a flood, or still
  int seed = g >> 3;
  float slow = u_time * 0.8 + float(seed) * 0.37;
  uint spell = cellHash(ivec2(int(floor(slow)), seed + 101));
  // Humming: a faint waver.
  if ((spell & 3u) != 0u) return 0.9 + 0.1 * sin(u_time * 23.0 + float(seed));
  // Stuttering: off and on in quick, uneven snaps.
  uint tick = cellHash(ivec2(int(floor(u_time * 13.0)), seed + 202));
  return (tick & 255u) < 120u ? 0.06 : 1.0;
}

float switchedOn(int g) {
  int state = g & 7;
  // Headlight beams and candles shine with the vehicles' own lamps; floodlights come on early.
  // Shops and carts, open while their lights are needed, light up with the dusk.
  if (
    state == ${LampState.beam} ||
    state == ${LampState.candle} ||
    state == ${LampState.shop} ||
    state == ${LampState.bulb}
  ) {
    return lamps();
  }
  if (state == ${LampState.flood}) return smoothstep(0.2, 0.3, 1.0 - u_daylight);
  float at = 0.3 + 0.3 * float(g >> 3) / 31.0;
  return smoothstep(at, at + 0.04, 1.0 - u_daylight);
}

float poolGlow() {
  return 0.6 * (1.0 + 0.6 * u_rain);
}

// The streetlight pool over the cell being drawn, for rain falling through it (rainOver).
float rainLight = 0.0;

float reflection(vec2 at, ivec2 cell) {
  ivec2 size = textureSize(u_light, 0);
  // Most water has no lamp above it: look at every third cell up the streak before tracing it
  // (the smallest pool, with its claimed rim, is four cells across).
  ivec2 c = ivec2(floor(at));
  float claimed = 0.0;
  for (int k = 0; k <= 9; k += 3) {
    claimed += texelFetch(u_light, clamp(c - ivec2(0, k), ivec2(0), size - 1), 0).a;
  }
  if (claimed < 0.5) return 0.0;
  float row = float(u_origin.y + cell.y);
  if (u_shimmer) at.x += sin(u_time * 1.7 + row * 0.9) * 0.35;
  float best = 0.0;
  for (int k = 0; k <= 10; k++) {
    vec2 p = at - vec2(0.0, float(k));
    if (p.y < 0.0) break;
    vec4 t = texelFetch(u_light, clamp(ivec2(floor(p)), ivec2(0), size - 1), 0);
    if (t.a < 0.5) continue;
    int g = int(t.g * 255.0 + 0.5);
    // Beams don't reach across the water; lamps, floods, and candles do.
    if ((g & 7) == ${LampState.beam}) continue;
    ivec2 candleCell = clamp(ivec2(floor(p)), ivec2(0), size - 1);
    float clock = (g & 7) == ${LampState.candle} ? effectTime(candleCell, 1) : u_lifeTime;
    float s = texture(u_light, p / vec2(size)).r * lampOn(g, clock) * switchedOn(g);
    best = max(best, s * (1.0 - float(k) / 12.0));
  }
  float ripple = u_shimmer ? 0.55 + 0.45 * sin(row * 2.1 + u_time * 2.3) : 0.8;
  return best * ripple * u_lampShow;
}

// The color of the light over the cell being drawn: warm sodium, whiter for a floodlight.
vec3 poolColor = LAMP;

// A color warmed by a streetlight's pool (0–1).
vec3 lampLit(vec3 color, float pool) {
  return mix(color, max(color, poolColor), pool * 0.75);
}

float groundAt(ivec2 c) {
  c = clamp(c, ivec2(0), textureSize(u_glyphs, 0) - 1);
  int k = int(texelFetch(u_glyphs, c, 0).g * 255.0 + 0.5) & 63;
  return (u_cellBits[k] & ${CellBit.person}) != 0 ? 1.0 : 0.3;
}

// How much of the ground around a pixel (at, in cells) takes the light: the four nearest
// cells blended by where the pixel sits among them, so light fades across the edge of an area
// instead of stopping at a cell's edge.
float groundMask(vec2 at) {
  vec2 p = at - 0.5;
  ivec2 c = ivec2(floor(p));
  vec2 f = p - floor(p);
  float top = mix(groundAt(c), groundAt(c + ivec2(1, 0)), f.x);
  float bottom = mix(groundAt(c + ivec2(0, 1)), groundAt(c + ivec2(1, 1)), f.x);
  return mix(top, bottom, f.y);
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
    if ((index & ${BRAKE_LAMP}) != 0 && (byte & 128) == 0)
      return mix(daylit(vec3(${BRAKE_COLOR.day.map(float).join(', ')})),
        vec3(${BRAKE_COLOR.night.map(float).join(', ')}) * ${float(BRAKE_COLOR.glow)}, lit);
    return mix(daylit(vec3(0.78, 0.14, 0.1)), vec3(1.0, 0.22, 0.14), lit);
  }
  if (part == ${VehiclePart.mini}) return mix(color, vec3(1.0, 0.95, 0.8), lit * 0.7);
  return color;
}

// A person's color (life/people.ts): full ink is their paint (a shirt, an umbrella's canopy); the
// tone ink is their skin (the theme's person color) or a canopy's ribs. No paint, the person color.
vec3 personColor(int byte, float coverage) {
  int index = byte & 15;
  vec3 paint = index < ${PAINT_COUNT} ? u_paints[min(index, ${PAINT_COUNT - 1})] : u_colors[u_person];
  int part = (byte >> 4) & 7;
  // A stamped figure's cells say which ink they show (life/draw.ts stampFigure).
  if (part == ${PersonPart.puff}) {
    vec3 smoke = (index & ${PUFF_KIND_BIT}) == 0 ? vec3(${PUFF_COLOR.diesel.map(float).join(', ')}) : vec3(${PUFF_COLOR.twoStroke.map(float).join(', ')});
    return mix(daylit(smoke), smoke * 0.65, lamps() * 0.7);
  }
  if (part == ${PersonPart.skin}) return daylit(u_colors[u_person]);
  if (part == ${PersonPart.rib}) return daylit(paint * 0.6);
  bool tone = coverage < 0.7;
  if (part == ${PersonPart.canopy}) return daylit(tone ? paint * 0.6 : paint);
  return daylit(tone ? u_colors[u_person] : paint);
}

// A bird's color (life/birds.ts): its species' body, or its accent where a stamped cell says so
// or a silhouette's tone ink is. A bird without a species (byte 255), the theme's bird color.
vec3 birdColor(int byte, float coverage) {
  if (byte == 255) return daylit(u_colors[u_bird]);
  int species = min(byte & 15, ${BIRD_SPECIES_ORDER.length - 1});
  bool accent = (byte & ${BIRD_ACCENT_BIT}) != 0 ||
    ((byte & ${BIRD_SILHOUETTE_BIT}) != 0 && coverage < 0.7);
  return daylit(u_birdPaints[species * 2 + (accent ? 1 : 0)]);
}

int imodRain(int a, int n) {
  return ((a % n) + n) % n;
}

// Rain over the map (life/wind.ts rainDrop): the map dims, and drops fall down the screen,
// drifting with the wind. Drops falling through a streetlight's pool glint warm.
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
  vec3 drop = mix(u_rainColor, vec3(1.0, 0.9, 0.7), min(1.0, rainLight * 1.5));
  return mix(color, drop, min(1.0, ink * ${float(RAIN.ink)} * u_rain * (1.0 + rainLight)));
}

bool fixtureSurface(int cls, ivec2 cell) {
  if (cls == u_vehicleOccluders.x || cls == u_vehicleOccluders.y || cls == u_vehicleOccluders.z) return false;
  return (u_cellBits[cls] & ${CellBit.person}) != 0 ||
    ((u_cellBits[cls] & ${CellBit.grounds}) != 0 && texelFetch(u_attr, cell, 0).r == 0.0);
}

// A short colored approach ray and nighttime halo. The cached lookup names one source;
// CSS-pixel distances keep the light compact at every zoom and device pixel ratio.
vec3 signalGlow(vec2 grid, ivec2 cell, float night, bool allowed) {
  if (!u_signalGlow || !allowed) return vec3(0.0);
  vec4 lookup = texelFetch(u_signalLight, cell, 0);
  if (lookup.a == 0.0) return vec3(0.0);
  ivec2 source = cell + ivec2(floor(lookup.rg * 255.0 + 0.5)) - 128;
  ivec2 size = textureSize(u_fixtures, 0);
  if (any(lessThan(source, ivec2(0))) || any(greaterThanEqual(source, size))) return vec3(0.0);
  vec4 fixture = texelFetch(u_fixtures, source, 0);
  if (fixture.a == 0.0) return vec3(0.0);
  int part = int(fixture.g * 255.0 + 0.5) & 63;
  int phase = int(fixture.b * 255.0 + 0.5);
  bool emitting = part == ${FixturePart.signal} ||
    (part >= ${FixturePart.red} && part <= ${FixturePart.green} && part - ${FixturePart.red} == phase);
  if (!emitting) return vec3(0.0);
  int cls = int(texelFetch(u_glyphs, source, 0).g * 255.0 + 0.5) & 63;
  if (!fixtureSurface(cls, source)) return vec3(0.0);
  float angle = floor(lookup.b * 255.0 + 0.5) * 6.28318530718 / 256.0;
  vec2 direction = vec2(cos(angle), sin(angle));
  vec2 delta = (grid - (vec2(source) + 0.5) * u_cell) / u_dpr;
  float forward = dot(delta, direction);
  float across = abs(dot(delta, vec2(-direction.y, direction.x)));
  float reach = mix(${float(SIGNAL_LIGHT.dayLength)}, ${float(SIGNAL_LIGHT.nightLength)}, night);
  float width = ${float(SIGNAL_LIGHT.halfWidth)} + max(0.0, forward) * ${float(SIGNAL_LIGHT.spread)};
  float beam = 0.0;
  if (forward >= 0.0 && forward < reach) {
    beam = (1.0 - smoothstep(0.0, reach, forward)) * (1.0 - smoothstep(0.0, width, across)) *
      mix(${float(SIGNAL_LIGHT.dayStrength)}, ${float(SIGNAL_LIGHT.nightStrength)}, night);
  }
  float falloff = 1.0 - smoothstep(0.0, ${float(SIGNAL_LIGHT.haloRadius)}, length(delta));
  float halo = falloff * falloff * ${float(SIGNAL_LIGHT.haloStrength)} * night;
  return u_fixturePaints[3 + min(phase, 2)] * (beam + halo) * fixture.a;
}

${seasonal ? buntingMotionGlsl : ''}
${seasonal ? festivePulseGlsl : ''}
${seasonal ? carnivalMotionGlsl : ''}

// Fixtures compose over agents and map ink, leaving the underlying glyph visible around them.
vec3 fixtureOver(vec3 under, vec4 fixture, ivec2 inCell, ivec2 cell, bool allowed, vec3 halo) {
  if (fixture.a == 0.0) return under + halo;
  int packed = int(fixture.g * 255.0 + 0.5);
  int part = packed & 63;
  ${
    seasonal
      ? /* glsl */ `
  bool roofMounted = part == ${FixturePart.buildingLight} || part == ${FixturePart.buildingWire};
  if (roofMounted) {
    // Only explicitly mounted strings may draw above a standing building.
    int cls = int(texelFetch(u_glyphs, cell, 0).g * 255.0 + 0.5) & 63;
    if ((u_cellBits[cls] & ${CellBit.window}) == 0 || texelFetch(u_attr, cell, 0).r == 0.0) return under + halo;
  } else if (!allowed) {
    // Crown-mounted bulbs sit on the foliage; ordinary hardware stays beneath it.
    int cls = int(texelFetch(u_glyphs, cell, 0).g * 255.0 + 0.5) & 63;
    bool foliage = cls == u_vehicleOccluders.x || cls == u_vehicleOccluders.y || cls == u_vehicleOccluders.z;
    if ((part != ${FixturePart.festiveLight} && part != ${FixturePart.carnivalLight}) || !foliage) return under + halo;
  }`
      : 'if (!allowed) return under + halo;'
  }
  int glyph = int(fixture.r * 255.0 + 0.5) + 256 * (packed >> 6);
  int info = int(fixture.b * 255.0 + 0.5);
  ivec2 at = ivec2(glyph % u_columns, glyph / u_columns) * ivec2(u_cell);
  ${
    seasonal
      ? /* glsl */ `bool rideMotion = part >= ${FixturePart.carouselMotion} && part <= ${FixturePart.bumperMotion};
  float buntingFold = 1.0;
  float ink = part == ${FixturePart.bunting} ? buntingInk(at, inCell, cell, info >> 3, buntingFold) :
    rideMotion ? 1.0 : texelFetch(u_atlas, at + inCell, 0).r;`
      : 'float ink = texelFetch(u_atlas, at + inCell, 0).r;'
  }
  vec3 color = lampLit(daylit(u_fixturePaints[0]), rainLight);
  if (part >= ${FixturePart.flagBlue} && part <= ${FixturePart.flagGold}) {
    vec3 paint = part == ${FixturePart.flagBlue} ? vec3(0.04, 0.22, 0.70) :
      part == ${FixturePart.flagRed} ? vec3(0.82, 0.08, 0.16) :
      part == ${FixturePart.flagGold} ? vec3(1.0, 0.78, 0.12) : vec3(0.96, 0.96, 0.93);
    float fold = 0.68 + 0.32 * float(info) / 255.0;
    if (u_shimmer) fold *= 0.97 + 0.03 * sin(u_time * 1.6 + float(info) * 0.045);
    color = lampLit(daylit(paint * fold), rainLight);
    if (part == ${FixturePart.flagGold})
      under = mix(under, daylit(vec3(0.96, 0.96, 0.93) * fold), fixture.a);
  }
  if (part == ${FixturePart.flagMast}) color = daylit(vec3(0.92, 0.94, 0.96));
  if (part == ${FixturePart.flagPlinth}) color = daylit(vec3(0.70, 0.73, 0.75));
  if (part == ${FixturePart.flagFoot}) color = daylit(vec3(0.43, 0.39, 0.33));
  if (part == ${FixturePart.casing}) color = daylit(u_fixturePaints[1]);
  if (part == ${FixturePart.lamp}) {
    float lit = lampOn(info, u_lifeTime) * switchedOn(info);
    color = mix(color, u_fixturePaints[2], lit);
  }
  if (part >= ${FixturePart.red} && part <= ${FixturePart.green}) {
    int lens = part - ${FixturePart.red};
    color = u_fixturePaints[3 + lens] * (info == lens ? 1.0 : 0.35);
    under = mix(under, daylit(u_fixturePaints[1]), fixture.a * 0.85);
  }
  if (part == ${FixturePart.signal}) color = u_fixturePaints[3 + min(info, 2)];
  if (part >= ${FixturePart.utilityCap} && part <= ${FixturePart.transformer})
    color = lampLit(daylit(u_fixturePaints[6]), rainLight);
  if (part == ${FixturePart.cable} || part == ${FixturePart.tangle})
    color = max(daylit(u_fixturePaints[7]), u_fixturePaints[7] * 0.5);
  ${
    seasonal
      ? /* glsl */ `if (part == ${FixturePart.lantern}) {
    float lit = lampOn(info, u_time) * switchedOn(info);
    color = mix(lampLit(daylit(u_fixturePaints[9]), rainLight), u_fixturePaints[2], lit);
  }
  if (part == ${FixturePart.bunting}) {
    color = lampLit(daylit(u_fixturePaints[8 + min(info & 7, 2)] * buntingFold), rainLight);
  }
  if (part == ${FixturePart.festiveTree}) {
    color = lampLit(daylit(vec3(0.08, 0.42, 0.22) * (0.65 + 0.35 * float(info) / 255.0)), rainLight);
  }
  if (part == ${FixturePart.carnivalRoof}) {
    int tint = info & 7;
    vec3 paint = carnivalPaint(tint);
    // Local ride illumination keeps saturated paint readable at night.
    color = max(lampLit(daylit(paint), rainLight), paint * 0.84);
  }
  if (part == ${FixturePart.carnivalGround}) {
    vec3 paint = info == 1 ? vec3(0.64, 0.44, 0.24) : info == 2 ? vec3(0.07, 0.38, 0.43) :
      info == 3 ? vec3(0.26, 0.12, 0.42) : vec3(0.16, 0.23, 0.24);
    color = max(lampLit(daylit(paint), rainLight), paint * 0.75);
    // A faint continuous floor connects the ASCII texture and delineates the aisle.
    under = mix(under, color * 0.34, fixture.a);
  }
  if (part == ${FixturePart.accessSurface}) {
    int style = info & 3, role = info >> 2;
    vec3 paint = style == 0 ? vec3(0.38, 0.36, 0.31) : vec3(0.14, 0.16, 0.18);
    vec3 ground = max(lampLit(daylit(paint), rainLight), paint * 0.28);
    under = mix(under, ground * 0.22, fixture.a);
    if (role == 1) paint = vec3(0.49, 0.48, 0.43);
    if (role == 2) paint = vec3(0.24, 0.23, 0.20);
    if (role == 3) paint = vec3(0.78, 0.80, 0.77);
    color = max(lampLit(daylit(paint), rainLight), paint * (role == 3 ? 0.65 : 0.35));
  }
  if (part == ${FixturePart.carnivalFrame}) color = max(lampLit(daylit(vec3(0.61, 0.76, 0.78)), rainLight), vec3(0.43, 0.54, 0.55));
  if (rideMotion) {
    int local = (glyph << 8) | info;
    vec2 uv = vec2(float(local & 511), float((local >> 9) & 511)) / 255.5 - 1.0;
    vec4 surface = carnivalSurface(part, uv, u_shimmer ? u_time : 0.0);
    color = max(lampLit(daylit(surface.rgb), rainLight), surface.rgb * 0.84);
    if (surface.a < 0.5) {
      under = mix(under, color * 0.34, fixture.a);
      ink = (inCell.x + inCell.y) % 4 == 0 ? 1.0 : 0.0;
    }
  }
  if (part == ${FixturePart.festiveWire} || part == ${FixturePart.buildingWire}) color = daylit(u_fixturePaints[7]);
  if (part == ${FixturePart.festiveLight} || part == ${FixturePart.festiveOrnament} || part == ${FixturePart.buildingLight} || part == ${FixturePart.carnivalLight}) {
    int tint = info & 7;
    vec3 paint = tint == 1 ? vec3(1.0, 0.22, 0.17) : tint == 2 ? vec3(0.26, 0.95, 0.42) :
      tint == 3 ? vec3(1.0, 0.28, 0.63) : tint == 4 ? vec3(0.70, 0.38, 1.0) :
      tint == 5 ? vec3(1.0, 0.97, 0.86) : vec3(1.0, 0.77, 0.32);
    color = mix(lampLit(daylit(paint * 0.78), rainLight), paint * festivePulse(info >> 3), darkness());
    if (part == ${FixturePart.carnivalLight}) {
      vec2 local = (vec2(inCell) + 0.5) / u_cell - 0.5;
      float glow = (1.0 - smoothstep(0.0, 0.65, length(local))) * darkness();
      under = max(under, vec3(0.04, 0.055, 0.06)) + paint * glow * 0.16;
    }
  }
  `
      : ''
  }
  if (u_focus && !(part >= ${FixturePart.red} && part <= ${FixturePart.green}) && part != ${FixturePart.signal}) color *= ${float(FOCUS_DIM)};
  return mix(under, color, ink * fixture.a) + halo;
}

int maskBit(int mask, int cls) { return cls < 32 ? ((mask >> cls) & 1) : 0; }

bool focusedClass(int cls) {
  return cls > 0 && cls < 64 && (u_focusClasses[cls >> 5] & (1u << uint(cls & 31))) != 0u;
}
float focusPulse() { return u_shimmer ? 0.75 + 0.25 * sin(u_time * 3.0) : 1.0; }

// Shared by agent compositing and halo sampling, including canopy edge surfaces.
bool lifeAllowedAt(vec4 life, int cls, int sampled, float coarseHeight, float sampledHeight) {
  int bits = int(life.b * 255.0 + 0.5) & ${LIFE_AGENT_MASK};
  if (bits == 0) return false;
  int lifeClass = int(life.g * 255.0 + 0.5) & 63;
  bool nonBird = lifeClass != u_bird;
  bool sampleSurface = nonBird && cls != u_vehicleOccluders.x;
  int surface = sampleSurface ? sampled : cls;
  if (nonBird && (surface == u_vehicleOccluders.x || surface == u_vehicleOccluders.y || surface == u_vehicleOccluders.z)) return false;
  bool grounds = (bits == ${CellBit.person} || bits == ${EVENT_PERSON_BITS}) && (u_cellBits[surface] & ${CellBit.grounds}) != 0 &&
    (sampleSurface ? sampledHeight : coarseHeight) == 0.0;
  return (u_cellBits[surface] & bits) != 0 || grounds;
}

bool lifeAllowed(vec4 life, int cls, ivec2 cell, ivec2 subAt) {
  int bits = int(life.b * 255.0 + 0.5) & ${LIFE_AGENT_MASK};
  if (bits == 0) return false;
  bool sampleSurface = (int(life.g * 255.0 + 0.5) & 63) != u_bird && cls != u_vehicleOccluders.x;
  int surface = sampleSurface ? int(texelFetch(u_subClass, subAt, 0).r * 255.0 + 0.5) : cls;
  float height = 0.0;
  if ((bits == ${CellBit.person} || bits == ${EVENT_PERSON_BITS}) && (u_cellBits[surface] & ${CellBit.grounds}) != 0)
    height = (sampleSurface ? texelFetch(u_subAttr, subAt, 0) : texelFetch(u_attr, cell, 0)).r;
  return lifeAllowedAt(life, cls, surface, height, height);
}

vec3 focusHalo(vec2 grid, ivec2 cell, int cls, ivec2 subAt) {
  if (!u_focus) return vec3(0.0);
  float halo = 0.0;
  ivec2 size = textureSize(u_glyphs, 0);
  int receivingSurface = 0;
  float receivingHeight = 0.0, receivingSubHeight = 0.0;
  if (u_focusLife) {
    receivingSurface = int(texelFetch(u_subClass, subAt, 0).r * 255.0 + 0.5);
    receivingHeight = texelFetch(u_attr, cell, 0).r;
    receivingSubHeight = texelFetch(u_subAttr, subAt, 0).r;
  }
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    if (x == 0 && y == 0) continue;
    ivec2 neighbor = cell + ivec2(x, y);
    if (any(lessThan(neighbor, ivec2(0))) || any(greaterThanEqual(neighbor, size))) continue;
    vec4 g = texelFetch(u_glyphs, neighbor, 0);
    int k = int(g.g * 255.0 + 0.5) & 63;
    bool match = focusedClass(k);
    if (u_focusLife) {
      vec4 life = texelFetch(u_life, neighbor, 0);
      if ((int(life.b * 255.0 + 0.5) & ${LIFE_FOCUS_BIT}) != 0) {
        vec2 local = clamp(grid - vec2(neighbor) * u_cell, vec2(0.0), u_cell - 0.001);
        ivec2 sub = ivec2(${SUB.cols}, ${SUB.rows});
        ivec2 sampleAt = neighbor * sub + clamp(ivec2(local / u_cell * vec2(sub)), ivec2(0), sub - 1);
        match = match || (lifeAllowed(life, k, neighbor, sampleAt) &&
          lifeAllowedAt(life, cls, receivingSurface, receivingHeight, receivingSubHeight));
      }
    }
    if (!match) continue;
    vec2 delta = max(max(vec2(neighbor) * u_cell - grid, grid - vec2(neighbor + 1) * u_cell), vec2(0.0));
    float distance = length(delta / u_cell);
    halo = max(halo, 1.0 - smoothstep(0.0, 1.0, distance));
  }
  return u_accent * halo * 0.18 * focusPulse();
}

void main() {
  vec2 screen = vec2(gl_FragCoord.x, u_height - gl_FragCoord.y);
  vec2 grid = screen + u_shift;
  ivec2 cell = ivec2(floor(grid / u_cell));
  ivec2 inCell = ivec2(grid - vec2(cell) * u_cell);
  ivec2 sub = ivec2(${SUB.cols}, ${SUB.rows});
  ivec2 subAt = cell * sub + clamp(ivec2(vec2(inCell) / u_cell * vec2(sub)), ivec2(0), sub - 1);

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
  int cls = int(g.g * 255.0 + 0.5) & 63;
  int rawState = int(g.b * 255.0 + 0.5);
  bool edge = (rawState & ${EDGE_STATE}) != 0;
  int windLevel = (rawState >> ${WIND_SHIFT}) & 3;
  int tone = (rawState >> ${TONE_SHIFT}) & 3;
  int awning = (u_cellBits[cls] & ${CellBit.frontage}) != 0 ? (rawState >> ${WIND_SHIFT}) & 15 : 0;
  bool shaded = (rawState & ${SHADOW_STATE}) != 0;
  int state = rawState & ${EDGE_STATE - 1};
  int bgClass = int(g.a * 255.0 + 0.5);
  float night = darkness();
  // The cell's background: its fill class's color, faint (theme.ts ClassStyle.fill).
  vec3 back = fillOf(bgClass, daylit(u_colors[bgClass]));
  // A shadow darkens the ground and whatever stands in it (glyphs/select.ts SHADOW).
  float shade = shaded ? 1.0 - ${float(SHADOW.dark)} : 1.0;
  back *= shade;

  // Streetlights (life/lights.ts): a pool of light on the ground around each lamp, once it has
  // switched on. The pool is read filtered, so it fades smoothly across cells; which lamp it
  // belongs to (its state and seed) and its head are per cell.
  vec4 light = texelFetch(u_light, cell, 0);
  float lampsNow = lamps() * u_lampShow;
  int lampG = int(light.g * 255.0 + 0.5);
  bool brakeGlow = (lampG & 7) == ${LampState.beam} && (lampG >> 3) == ${BRAKE_GLOW.seed};
  float lampClock = (lampG & 7) == ${LampState.candle} ? effectTime(cell, 1) : u_lifeTime;
  float lampLight = lampsNow > 0.0 ? lampOn(lampG, lampClock) * switchedOn(lampG) * u_lampShow : 0.0;
  bool ground = (u_cellBits[cls] & ${CellBit.person}) != 0;
  bool flood = (lampG & 7) == ${LampState.flood};
  // Floodlights and candles light wherever they are; streetlights light the ground.
  bool shop = (lampG & 7) == ${LampState.shop};
  // Floods, candles, and open shops light their own place, whatever it is.
  bool everywhere = flood || shop || (lampG & 7) == ${LampState.candle};
  poolColor = flood ? LAMP_WHITE : shop ? SHOP_LIGHT : LAMP;
  vec3 brakeColor = vec3(${BRAKE_COLOR.night.map(float).join(', ')});
  // Brake falloff belongs to its own cone; filtering must not borrow neighboring light strength.
  float poolR = brakeGlow ? light.r : texture(u_light, grid / u_cell / vec2(textureSize(u_light, 0))).r;
  // Streetlights light the ground, fading across its edges.
  float pool = 0.0;
  if (poolR > 0.01 && light.a > 0.5 && lampLight > 0.0) {
    if (brakeGlow) {
      // Like ground agents, the glow uses the visible subcell surface beneath canopy edges;
      // trunks remain occluders. Only road pixels receive the red spill.
      int surface = cls == u_vehicleOccluders.x ? cls :
        int(texelFetch(u_subClass, subAt, 0).r * 255.0 + 0.5);
      if ((u_cellBits[surface] & ${CellBit.vehicle}) != 0) pool = poolR * lampLight;
    } else {
      pool = poolR * lampLight * (everywhere ? 1.0 : groundMask(grid / u_cell));
    }
  }
  // Road spill never recolors fixture ink or rain streaks.
  rainLight = brakeGlow ? 0.0 : pool;
  // On water, the lamps along the bank reflect.
  bool water = (u_cellBits[cls] & ${CellBit.boat}) != 0;
  float refl = water && lampsNow > 0.0 ? reflection(grid / u_cell, cell) : 0.0;
  vec3 glow = (brakeGlow ? vec3(0.0) : poolColor * pool * poolGlow()) + LAMP * refl * 0.9;
  // Under the moon, water glints linger on staggered beats (still with reduced motion).
  if (water && u_moon > 0.0 && night > 0.0) {
    ivec2 world = u_origin + cell;
    // Each cell re-rolls its glint on its own 2 s beat, so glints linger and don't all jump at once.
    float stagger = float(cellHash(world) & 255u) / 256.0;
    int beat = u_shimmer ? int(floor(u_time * 0.5 + stagger)) : 0;
    uint h = cellHash(world + ivec2(beat * 7919, beat * 104729));
    if (float(h & 1023u) / 1024.0 < 0.04 * u_moon * night) glow += vec3(0.55, 0.6, 0.72) * 0.6;
  }
  // A colour wash also reads on the light theme's paper, where additive red would clip white.
  back = (brakeGlow ? mix(back, brakeColor, pool * poolGlow()) : back) + glow;
  vec3 focusGlow = focusHalo(grid, cell, cls, subAt);
  if (u_focus) back = focusedClass(bgClass) ? mix(back, u_accent, 0.25 * focusPulse()) : back * ${float(FOCUS_DIM)};
  back += focusGlow;
  vec4 fixture = texelFetch(u_fixtures, cell, 0);
  bool fixtureAllowed = fixtureSurface(cls, cell);
  vec3 signalHalo = signalGlow(grid, cell, night, fixtureAllowed);

  // Agents stand on top where the cell under them allows; people also on grounds (a church's
  // or a school's) where no building stands (height 0).
  vec4 life = texelFetch(u_life, cell, 0);
  int lifeFlags = int(life.b * 255.0 + 0.5);
  int lifeBit = lifeFlags & ${LIFE_AGENT_MASK};
  // A flying bird's shadow on the ground (life/draw.ts drawShadows).
  if (lifeBit == 0 && int(life.a * 255.0 + 0.5) == ${LIFE_SHADOW}) {
    back *= ${(1 - BIRD_SHADOW.dark).toFixed(3)};
  }
  int lifeClass = int(life.g * 255.0 + 0.5) & 63;
  if (lifeAllowed(life, cls, cell, subAt)) {
    int lifeGlyph = int(life.r * 255.0 + 0.5) + 256 * (int(life.g * 255.0 + 0.5) >> 6);
    ivec2 slot = ivec2(lifeGlyph % u_columns, lifeGlyph / u_columns) * ivec2(u_cell);
    float coverage = texelFetch(u_atlas, slot + inCell, 0).r;
    int lifeByte = int(life.a * 255.0 + 0.5);
    bool painted = lifeClass == u_vehicle || lifeClass == u_boat || lifeClass == u_train;
    bool person = lifeClass == u_person;
    bool puff = person && ((lifeByte >> 4) & 7) == ${PersonPart.puff};
    bool bird = lifeClass == u_bird;
    vec3 color = painted
      ? vehicleColor(lifeByte, night)
      : person ? personColor(lifeByte, coverage)
      : bird ? birdColor(lifeByte, coverage) : daylit(u_colors[lifeClass]);
    if (lifeClass == u_vehicle && (lifeFlags & ${TURN_SIGNAL_BIT}) != 0 && (lifeByte & 128) == 0)
      color = vec3(${TURN_SIGNAL_COLOR.map(float).join(', ')});
    // A figure's two inks are both solid (glyphs/atlas.ts drawFigure), and a bird's.
    if ((person && !puff) || (bird && (lifeByte & ${BIRD_SILHOUETTE_BIT}) != 0)) {
      coverage = coverage > 0.0 ? 1.0 : 0.0;
    }
    if (person && (lifeByte & ${CANDLE_BIT}) != 0) {
      // A candle, from dusk: warm, each flickering on its own beat.
      float beat = float(cellHash(u_origin + cell) & 7u) + 3.0;
      float flicker = u_shimmer ? 0.85 + 0.15 * sin(effectTime(cell, 0) * beat) : 1.0;
      color = mix(color, vec3(1.0, 0.78, 0.4) * flicker, lamps());
    }
    color = lampLit(color, brakeGlow ? 0.0 : pool);
    if (puff) color = mix(back, color, 1.0 - float(lifeByte & ${PUFF_AGE_MASK}) / ${float(PUFF_AGE_MASK)});
    if (u_focus) {
      color = (lifeFlags & ${LIFE_FOCUS_BIT}) != 0 ? u_accent * focusPulse() : color * ${float(FOCUS_DIM)};
      if (lifeClass == u_vehicle && (lifeFlags & ${TURN_SIGNAL_BIT}) != 0 && (lifeByte & 128) == 0) color = vec3(${TURN_SIGNAL_COLOR.map(float).join(', ')});
    }
    o_color = vec4(rainOver(fixtureOver(mix(back, color, coverage), fixture, inCell, cell, fixtureAllowed, signalHalo), cell, inCell), 1.0);
    return;
  }

  if (cls == 0) {
    o_color = vec4(rainOver(fixtureOver(back, fixture, inCell, cell, fixtureAllowed, signalHalo), cell, inCell), 1.0);
    return;
  }
  int glyph = int(g.r * 255.0 + 0.5) + 256 * (int(g.g * 255.0 + 0.5) >> 6);
  if (water) {
    // Fish only in rivers and ponds; rain splashes on any water, below boats and labels.
    int effect = waterEffect(cell, cls == u_fishWater.x || cls == u_fishWater.y);
    if (effect >= 0) glyph = u_waterGlyphs[effect];
  }
  ivec2 slot = ivec2(glyph % u_columns, glyph / u_columns) * ivec2(u_cell);
  float coverage = texelFetch(u_atlas, slot + inCell, 0).r;
  vec3 color = awning > 0 ? daylit(u_awningPaints[min(awning - 1, 7)]) : toned(daylit(u_colors[cls]), tone, night);
  if (cls == u_crownClass) {
    vec2 local = (edge ? texelFetch(u_subAttr, subAt, 0) : texelFetch(u_attr, cell, 0)).gb * 2.0 - 1.0;
    vec3 normal = normalize(vec3(local * ${float(CROWN_LIGHT.tilt)},
      sqrt(max(${float(CROWN_LIGHT.minZ)}, 1.0 - dot(local, local)))));
    float light = clamp(
      ${float(CROWN_LIGHT.base)} + ${float(CROWN_LIGHT.gain)} * dot(normal, normalize(u_crownSun)),
      ${float(CROWN_LIGHT.min)}, ${float(CROWN_LIGHT.max)});
    float variation = 0.94 + 0.12 * float(cellHash((u_origin + cell) / 3) >> 8u) / 16777216.0;
    color *= light * variation;
    back *= light;
  }
  if (cls == u_pulse) color *= 0.7 + 0.3 * sin(u_time * 3.0);
  int bits = u_cellBits[cls];
  // Zoomed out, major and secondary roads glow as a lit corridor; it hands over to the streetlights.
  if ((bits & ${CellBit.streetlight}) != 0) {
    color = mix(color, LAMP, lamps() * 0.4 * (1.0 - u_lampShow));
  }
  color = lampLit(color, pool + refl);
  // A floodlit landmark glows itself, from early dusk (life/lights.ts floods).
  float floodOn = smoothstep(0.2, 0.3, 1.0 - u_daylight) * u_lampShow;
  if (floodOn > 0.0 && cls != u_crownClass) {
    int landmarkFlags = int(texelFetch(u_attr, cell, 0).g * 255.0 + 0.5);
    if ((landmarkFlags & ${Flags.landmark}) != 0) color = mix(color, LAMP_WHITE, 0.3 * floodOn);
  }
  if ((bits & ${CellBit.window}) != 0 && night > 0.0) {
    // More windows light up as the night deepens; each flickers a little on its own beat. The
    // world cell's hash picks them, so they stay put as the map pans.
    uint h = cellHash(u_origin + cell);
    if (float((h >> 4u) & 255u) / 255.0 < night * 0.12) {
      float beat = float((h >> 12u) & 7u) + 1.0;
      float flicker = u_shimmer ? 0.88 + 0.12 * sin(u_time * beat * 0.7) : 1.0;
      color = mix(color, vec3(1.0, 0.82, 0.48) * flicker, 0.85);
    }
  }
  // Blades caught by a gust show their pale sides, more as it strengthens (glyphs/select.ts
  // WIND_LIGHT by wind level).
  if (awning == 0 && windLevel > 0) {
    color = mix(color, vec3(1.0), windLevel == 3 ? ${float(WIND_LIGHT[3])}
      : windLevel == 2 ? ${float(WIND_LIGHT[2])} : ${float(WIND_LIGHT[1])});
  }
  if (state == ${CellState.hover}) {
    color = mix(color, vec3(1.0), 0.45);
  } else if (state == ${CellState.highlight}) {
    color = u_accent;
  } else if (state == ${CellState.selected}) {
    color = u_accent;
    if (u_shimmer) color *= 0.78 + 0.22 * sin(u_time * 2.5 - float(cell.x + cell.y) * 0.35);
  }
  // The feature's own fill takes its highlight too, so a selected footprint lights up whole.
  // (Its streetlight pool too, which that just replaced.)
  if (!edge && bgClass == cls) {
    vec3 fill = fillOf(cls, color) * shade;
    back = (brakeGlow ? mix(fill, brakeColor, pool * poolGlow()) : fill) + glow;
  }
  // A sub-cell edge draws the feature's part in a tone between its fill and its glyphs, so the
  // shape reads as one area with a crisp rim.
  if (edge) color = mix(fillOf(cls, color), color, ${EDGE_INK});
  color *= shade;
  if (u_focus) {
    color = focusedClass(cls) ? u_accent * focusPulse() : color * ${float(FOCUS_DIM)};
    if (!edge && bgClass == cls) back = (focusedClass(cls) ? mix(fillOf(cls, daylit(u_colors[cls])) * shade + glow, u_accent, 0.25 * focusPulse()) : (fillOf(cls, daylit(u_colors[cls])) * shade + glow) * ${float(FOCUS_DIM)}) + focusGlow;
  }
  o_color = vec4(rainOver(fixtureOver(mix(back, color, coverage), fixture, inCell, cell, fixtureAllowed, signalHalo), cell, inCell), 1.0);
}
`;
}

/** Full-feature source for external consumers and shader fixtures. */
export const glyphFragment = glyphFragmentFor();
