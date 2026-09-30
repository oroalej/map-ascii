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
 * night dims the map toward blue, lights some building cells as windows (tilted, only walls),
 * and turns on vehicles' head- and taillights; dusk warms it. From dusk, streetlights along major
 * and secondary roads cast pools of light (life/lights.ts); some are out and some flicker. Zoomed
 * out, those roads read as a lit corridor instead.
 * Vehicles take their colors from their paint and the part each cell shows.
 */
import { Flags, MAX_CLASSES } from '../classes';
import { BIRD_ACCENT_BIT, BIRD_SILHOUETTE_BIT, BIRD_SPECIES_ORDER } from '../life/birds';
import { BIRD_SHADOW, CellBit, LIFE_SHADOW } from '../life/config';
import { CANDLE_BIT, PersonPart } from '../life/people';
import { LampState } from '../life/lights';
import { PAINT_COUNT, VehiclePart } from '../life/vehicles';
import {
  EDGE_INK,
  EDGE_STATE,
  SHADOW,
  SHADOW_STATE,
  Tone,
  TONE,
  TONE_SHIFT,
  WIND_LIGHT,
  WIND_SHIFT,
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
                                  // vehicles' and people's paint (low 4 bits) and part (high 4)
uniform int u_cellBits[${MAX_CLASSES}]; // per map class: CellBit set
uniform ivec2 u_origin;           // world cell of texel (0, 0), for window hashes (flat views)
uniform bool u_tilted;            // perspective camera: windows by the cell pass's window key
uniform sampler2D u_attr;         // cell pass attributes (flags; walls' window key)
uniform float u_daylight;         // 0 night – 1 day
uniform int u_vehicle;            // the vehicles' class id (paints, lights)
uniform int u_boat;               // the boats' class id (paints, lights)
uniform int u_train;              // the trains' class id (paints, lights)
uniform int u_person;             // the people's class id (candles)
uniform int u_bird;               // the birds' class id (species colors)
uniform vec3 u_birdPaints[${BIRD_SPECIES_ORDER.length * 2}]; // per species: body, accent
uniform vec3 u_paints[${PAINT_COUNT}];   // vehicle paints (theme.ts vehiclePaints)
uniform float u_rain;             // how hard it rains, 0–1 (life/wind.ts RAIN)
uniform float u_rainSlant;        // columns a drop drifts per two rows (the wind's x)
uniform int u_rainGlyph;          // the rain glyph's atlas index
uniform vec3 u_rainColor;
uniform sampler2D u_light;        // RGBA8 streetlights (linear): pool, lamp state (bits 0–1) +
                                  // seed, head, whether a lamp claims the cell
uniform float u_lampShow;         // how far the streetlights have faded in at this zoom, 0–1
uniform int u_lampGlyph;          // the streetlight head's atlas index
uniform float u_moon;             // moonlight, 0 (new moon, or down) – 1 (full moon, high)

out vec4 o_color;

${cellHashGlsl}

// How dark it is: none until well into twilight, so dusk reads warm rather than dim.
float darkness() {
  return smoothstep(0.3, 1.0, 1.0 - u_daylight);
}

// The time of day: dim and blue at night, warm at dusk. Moonlight (life/moon.ts) lifts the night
// a little and turns it silver; a moonless night is darkest.
vec3 daylit(vec3 color) {
  float dusk = 1.0 - abs(u_daylight - 0.5) * 2.0;
  color = mix(color, color * vec3(1.2, 0.88, 0.68), dusk * 0.45);
  vec3 tint = mix(vec3(0.4, 0.48, 0.78), vec3(0.6, 0.64, 0.76), u_moon);
  return mix(color, color * tint, darkness() * (0.85 - 0.2 * u_moon));
}

// A vegetation cell's tint (glyphs/select.ts Tone, toneColor): the lit side is only lightened by
// day, so a tree's sunny side doesn't glow at night.
vec3 toned(vec3 color, int tone, float night) {
  if (tone == ${Tone.shade}) return color * ${float(TONE.shade)};
  if (tone == ${Tone.light}) return mix(color, vec3(1.0), ${float(TONE.light)} * (1.0 - night));
  if (tone == ${Tone.dry}) return min(color * vec3(${TONE.dry.map(float).join(', ')}), 1.0);
  return color;
}

// A class's fill in a color: the background tinted toward it by the class's fill strength.
vec3 fillOf(int cls, vec3 color) {
  return mix(u_background, color, u_fills[cls]);
}

// How much lamps and candles shine: from dusk, fully at night.
float lamps() {
  return smoothstep(0.25, 0.8, 1.0 - u_daylight);
}

const vec3 LAMP = vec3(1.0, 0.78, 0.45);

const vec3 LAMP_WHITE = vec3(1.0, 0.9, 0.7);
// A shop's warm interior light, spilling out of its door.
const vec3 SHOP_LIGHT = vec3(1.0, 0.74, 0.42);

// How much a light shines (life/lights.ts LampState, lightByte): a working streetlight fully,
// one that is out not at all. A flickering one is mostly on, but now and then stutters on and
// off, each on its own beat; a candle wavers softly. With reduced motion both hold steady.
float lampOn(int g) {
  int state = g & 7;
  if (state == ${LampState.dead}) return 0.0;
  if (state == ${LampState.candle}) {
    float beat = 5.0 + float(g >> 3) * 0.23;
    return u_shimmer ? 0.8 + 0.2 * sin(u_time * beat + float(g >> 3)) : 1.0;
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

// When a streetlight switches on: each at its own point in the dusk (by its seed), quickly, like
// a photocell clicking on, so they come on one by one, and go off the same way at dawn.
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

// How much a streetlight's pool brightens the ground: more on a wet road.
float poolGlow() {
  return 0.6 * (1.0 + 0.6 * u_rain);
}

// The streetlight pool over the cell being drawn, for rain falling through it (rainOver).
float rainLight = 0.0;

// A streetlight's reflection on water at a grid position (in cells): a streak running down
// the water below each lamp's pool, fading with distance, wavering and broken into ripples as the
// water moves (still with reduced motion).
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
    float s = texture(u_light, p / vec2(size)).r * lampOn(g) * switchedOn(g);
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

// Whether a cell takes a pool of light: open ground fully, anything else (roofs, walls, water)
// a faint wash.
float groundAt(ivec2 c) {
  c = clamp(c, ivec2(0), textureSize(u_glyphs, 0) - 1);
  int k = int(texelFetch(u_glyphs, c, 0).g * 255.0 + 0.5);
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
  int windLevel = (rawState >> ${WIND_SHIFT}) & 3;
  int tone = (rawState >> ${TONE_SHIFT}) & 3;
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
  float lampLight = lampsNow > 0.0 ? lampOn(lampG) * switchedOn(lampG) * u_lampShow : 0.0;
  bool ground = (u_cellBits[cls] & ${CellBit.person}) != 0;
  bool flood = (lampG & 7) == ${LampState.flood};
  // Floodlights and candles light wherever they are; streetlights light the ground.
  bool shop = (lampG & 7) == ${LampState.shop};
  // Floods, candles, and open shops light their own place, whatever it is.
  bool everywhere = flood || shop || (lampG & 7) == ${LampState.candle};
  poolColor = flood ? LAMP_WHITE : shop ? SHOP_LIGHT : LAMP;
  float poolR = texture(u_light, grid / u_cell / vec2(textureSize(u_light, 0))).r;
  // Streetlights light the ground, fading across its edges.
  float pool = 0.0;
  if (poolR > 0.01 && light.a > 0.5 && lampLight > 0.0) {
    pool = poolR * lampLight * (everywhere ? 1.0 : groundMask(grid / u_cell));
  }
  rainLight = pool;
  // On water, the lamps along the bank reflect.
  bool water = (u_cellBits[cls] & ${CellBit.boat}) != 0;
  float refl = water && lampsNow > 0.0 ? reflection(grid / u_cell, cell) : 0.0;
  vec3 glow = poolColor * pool * poolGlow() + LAMP * refl * 0.9;
  // Under the moon, water glints here and there, now and then (still with reduced motion).
  if (water && u_moon > 0.0 && night > 0.0) {
    int beat = u_shimmer ? int(floor(u_time * 2.0)) : 0;
    uint h = cellHash(u_origin + cell + ivec2(beat * 7919, beat * 104729));
    if (float(h & 1023u) / 1024.0 < 0.04 * u_moon * night) glow += vec3(0.55, 0.6, 0.72) * 0.6;
  }
  back += glow;

  // Agents stand on top where the cell under them allows; people also on grounds (a church's
  // or a school's) where no building stands (height 0).
  vec4 life = texelFetch(u_life, cell, 0);
  int lifeBit = int(life.b * 255.0 + 0.5);
  // A flying bird's shadow on the ground (life/draw.ts drawShadows).
  if (lifeBit == 0 && int(life.a * 255.0 + 0.5) == ${LIFE_SHADOW}) {
    back *= ${(1 - BIRD_SHADOW.dark).toFixed(3)};
  }
  bool onGrounds = lifeBit == ${CellBit.person} && (u_cellBits[cls] & ${CellBit.grounds}) != 0 &&
    texelFetch(u_attr, cell, 0).r == 0.0;
  if (lifeBit != 0 && ((u_cellBits[cls] & lifeBit) != 0 || onGrounds)) {
    int lifeGlyph = int(life.r * 255.0 + 0.5);
    int lifeClass = int(life.g * 255.0 + 0.5);
    ivec2 slot = ivec2(lifeGlyph % u_columns, lifeGlyph / u_columns) * ivec2(u_cell);
    float coverage = texelFetch(u_atlas, slot + inCell, 0).r;
    int lifeByte = int(life.a * 255.0 + 0.5);
    bool painted = lifeClass == u_vehicle || lifeClass == u_boat || lifeClass == u_train;
    bool person = lifeClass == u_person;
    bool bird = lifeClass == u_bird;
    vec3 color = painted
      ? vehicleColor(lifeByte, night)
      : person ? personColor(lifeByte, coverage)
      : bird ? birdColor(lifeByte, coverage) : daylit(u_colors[lifeClass]);
    // A figure's two inks are both solid (glyphs/atlas.ts drawFigure), and a bird's.
    if (person || (bird && (lifeByte & ${BIRD_SILHOUETTE_BIT}) != 0)) {
      coverage = coverage > 0.0 ? 1.0 : 0.0;
    }
    if (person && (lifeByte & ${CANDLE_BIT}) != 0) {
      // A candle, from dusk: warm, each flickering on its own beat.
      float beat = float(cellHash(u_origin + cell) & 7u) + 3.0;
      float flicker = u_shimmer ? 0.85 + 0.15 * sin(u_time * beat) : 1.0;
      color = mix(color, vec3(1.0, 0.78, 0.4) * flicker, lamps());
    }
    color = lampLit(color, pool);
    o_color = vec4(rainOver(mix(back, color, coverage), cell, inCell), 1.0);
    return;
  }

  // A lamp's head, from dusk: warm once lit, grey while off or when it is out.
  if (light.b > 0.5 && ground && lampsNow > 0.0) {
    int lampGlyph = u_lampGlyph;
    ivec2 lampSlot = ivec2(lampGlyph % u_columns, lampGlyph / u_columns) * ivec2(u_cell);
    float ink = texelFetch(u_atlas, lampSlot + inCell, 0).r;
    vec3 head = mix(daylit(vec3(0.5)), vec3(1.0, 0.92, 0.7), lampOn(lampG) * switchedOn(lampG));
    o_color = vec4(rainOver(mix(back, head, ink * min(1.0, lampsNow * 2.0)), cell, inCell), 1.0);
    return;
  }

  if (cls == 0) {
    o_color = vec4(rainOver(back, cell, inCell), 1.0);
    return;
  }
  int glyph = int(g.r * 255.0 + 0.5);
  ivec2 slot = ivec2(glyph % u_columns, glyph / u_columns) * ivec2(u_cell);
  float coverage = texelFetch(u_atlas, slot + inCell, 0).r;
  vec3 color = toned(daylit(u_colors[cls]), tone, night);
  if (cls == u_pulse) color *= 0.7 + 0.3 * sin(u_time * 3.0);
  int bits = u_cellBits[cls];
  // Zoomed out, major and secondary roads glow as a lit corridor; it hands over to the streetlights.
  if ((bits & ${CellBit.streetlight}) != 0) {
    color = mix(color, LAMP, lamps() * 0.4 * (1.0 - u_lampShow));
  }
  color = lampLit(color, pool + refl);
  // A floodlit landmark glows itself, from early dusk (life/lights.ts floods).
  float floodOn = smoothstep(0.2, 0.3, 1.0 - u_daylight) * u_lampShow;
  if (floodOn > 0.0) {
    int landmarkFlags = int(texelFetch(u_attr, cell, 0).g * 255.0 + 0.5);
    if ((landmarkFlags & ${Flags.landmark}) != 0) color = mix(color, LAMP_WHITE, 0.3 * floodOn);
  }
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
  // Blades caught by a gust show their pale sides, more as it strengthens (glyphs/select.ts
  // WIND_LIGHT by wind level).
  if (windLevel > 0) {
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
  if (!edge && bgClass == cls) back = fillOf(cls, color) * shade + glow;
  // A sub-cell edge draws the feature's part in a tone between its fill and its glyphs, so the
  // shape reads as one area with a crisp rim.
  if (edge) color = mix(fillOf(cls, color), color, ${EDGE_INK});
  color *= shade;
  o_color = vec4(rainOver(mix(back, color, coverage), cell, inCell), 1.0);
}
`;
