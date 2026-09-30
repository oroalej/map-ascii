/**
 * The life layer's vehicles (SPEC.md §4 "Life layer"): what kinds there are, how big, and how
 * each looks. A vehicle smaller than a couple of cells on screen is one glyph; a bigger one is
 * drawn at its real size from a top-down plan of its parts (life/draw.ts). Which kinds drive on
 * which roads is a city's traffic mix (its pack's `traffic`), over `DEFAULT_TRAFFIC`.
 */
import {
  TRAFFIC_ROADS,
  type BoatType,
  type TrafficMix,
  type TrafficRoad,
  type VehicleType,
} from '@atlas/shared';
import { LifeLine } from './geometry';

/**
 * A vehicle cell's part, which the glyph shader colors from the vehicle's paint
 * (shaders/glyph.ts). `mini` is a whole vehicle in one glyph.
 */
export const VehiclePart = {
  body: 0,
  roof: 1,
  glass: 2,
  headlight: 3,
  taillight: 4,
  trim: 5,
  /** A second color: a jeepney's stripes. */
  accent: 6,
  mini: 7,
} as const;
export type VehiclePart = (typeof VehiclePart)[keyof typeof VehiclePart];

/** The glyph each part is drawn with. The color does most of the work. */
export const PART_GLYPHS: Readonly<Record<Exclude<VehiclePart, typeof VehiclePart.mini>, string>> =
  {
    [VehiclePart.body]: '█',
    [VehiclePart.roof]: '▓',
    [VehiclePart.glass]: '▒',
    [VehiclePart.headlight]: '█',
    [VehiclePart.taillight]: '█',
    [VehiclePart.trim]: '▓',
    [VehiclePart.accent]: '█',
  };

/** Plan letters → parts; `.` is empty. */
const planLetters: Readonly<Record<string, VehiclePart>> = {
  B: VehiclePart.body,
  R: VehiclePart.roof,
  G: VehiclePart.glass,
  H: VehiclePart.headlight,
  T: VehiclePart.taillight,
  D: VehiclePart.trim,
  A: VehiclePart.accent,
};

/**
 * Paints, by index into the theme's `vehiclePaints` (theme.ts). At most 16: the life texel
 * keeps a vehicle's paint in 4 bits.
 */
export const Paint = {
  white: 0,
  silver: 1,
  graphite: 2,
  red: 3,
  maroon: 4,
  blue: 5,
  sky: 6,
  yellow: 7,
  green: 8,
  orange: 9,
  purple: 10,
  chrome: 11,
  cream: 12,
  teal: 13,
  pink: 14,
} as const;
export const PAINT_COUNT = 15;

export type VehicleSpec = {
  /** Meters. */
  length: number;
  width: number;
  /** Times the road's (or river's) speed (config.ts `spawnRules`). */
  speed: number;
  /** At most this fast, m/s. */
  maxSpeed?: number;
  /** Rides by the road's right edge instead of in a lane (config.ts `laneOffset`). */
  curb?: boolean;
  /** Paints it may have, each equally likely. */
  paints: readonly number[];
  /** One glyph when small: across the screen, then up or down. */
  mini: readonly [string, string];
  /**
   * Seen from above, front to the right: one string per row across the vehicle, its left side
   * first. Letters are parts (`planLetters`).
   */
  plan: readonly string[];
};

const P = Paint;

/** Boat paints never use these: they vanish on water. */
export const BOAT_PAINTS_AVOID: readonly number[] = [P.blue, P.sky, P.teal, P.green];

/** Something the life layer draws from a plan: a vehicle, a boat, or a vendor's cart. */
export type CraftType =
  VehicleType | BoatType | ProcessionCraft | RailCraft | StallCraft | AnimalCraft;

/** A farm animal (life/simulate.ts `Gatherer`): a carabao, led along a field by its farmer. */
export type AnimalCraft = 'carabao';

/** A street vendor's cart (life/simulate.ts `Stall`), which stands where people walk. */
export type StallCraft = 'cart';

/**
 * A cart as one glyph: a striped awning, drawn by the glyph atlas (glyphs/atlas.ts). A Private
 * Use code point, after people's figures (life/people.ts).
 */
export const STALL_GLYPH = '';

/** A train's cars (life/simulate.ts): a locomotive at the head, then its coaches. */
export type RailCraft = 'locomotive' | 'coach';

/** A train's paints: the whole train shares one. */
export const TRAIN_PAINTS: readonly number[] = [
  Paint.orange,
  Paint.orange,
  Paint.blue,
  Paint.cream,
];

/** A river procession's own boats (life/procession.ts). */
export type ProcessionCraft = 'pagoda' | 'voyador' | 'baroto' | 'sailboat';

export const VEHICLES: Readonly<Record<CraftType, VehicleSpec>> = {
  car: {
    length: 4.4,
    width: 1.8,
    speed: 1,
    paints: [P.white, P.white, P.silver, P.graphite, P.red, P.blue, P.maroon, P.cream],
    mini: ['▬', '▮'],
    // Trunk, rear window, roof, windshield, hood.
    plan: ['TBGRRRRGGBBH', 'BBGRRRRGGBBB', 'BBGRRRRGGBBB', 'TBGRRRRGGBBH'],
  },
  motorcycle: {
    length: 2,
    width: 0.8,
    speed: 1.1,
    paints: [P.graphite, P.red, P.blue, P.silver, P.graphite],
    mini: ['•', '•'],
    // The rider (trim) astride.
    plan: ['TBDDBH'],
  },
  tricycle: {
    length: 2.6,
    width: 1.6,
    speed: 0.8,
    paints: [P.red, P.blue, P.yellow, P.green, P.orange, P.sky, P.teal, P.purple],
    mini: ['▪', '▪'],
    // A motorcycle on the left, its roofed sidecar on the right, shorter at the front.
    plan: ['TBBDBBH', 'RRRRRG.', 'RRRRRG.'],
  },
  jeepney: {
    length: 7,
    width: 2,
    speed: 0.9,
    paints: [P.chrome, P.chrome, P.white, P.blue, P.red, P.yellow, P.green, P.purple, P.pink],
    mini: ['▬', '▮'],
    // A long roof striped down its sides, the open door at the back, a short hood.
    plan: ['TAAAAAAAAAGBBH', 'DRRRRRRRRRGBBB', 'TAAAAAAAAAGBBH'],
  },
  bus: {
    length: 11,
    width: 2.5,
    speed: 0.85,
    paints: [P.white, P.blue, P.yellow, P.green, P.red],
    mini: ['▬', '▮'],
    // Air conditioners on the roof.
    plan: ['TBBBBBBBBBBBBBBBGH', 'BRRDDRRRRRRDDRRRGB', 'TBBBBBBBBBBBBBBBGH'],
  },
  truck: {
    length: 8,
    width: 2.5,
    speed: 0.85,
    paints: [P.blue, P.red, P.white, P.green, P.yellow],
    mini: ['▬', '▮'],
    // A cargo bed behind the cab.
    plan: ['TDDDDDDDDDDBBBGH', 'DDDDDDDDDDDBBRGB', 'TDDDDDDDDDDBBBGH'],
  },
  bicycle: {
    length: 1.8,
    width: 0.6,
    speed: 0.7,
    maxSpeed: 5,
    curb: true,
    paints: [P.graphite, P.red, P.blue, P.silver, P.green, P.yellow],
    mini: ['·', '·'],
    // Two wheels and the rider (trim) between them.
    plan: ['TDBDDBH'],
  },
  rowboat: {
    length: 3.5,
    width: 1.3,
    speed: 0.7,
    paints: [P.white, P.cream, P.red, P.yellow, P.graphite],
    mini: ['◊', '◊'],
    // The rower amidships; no lights.
    plan: ['.BBBBB.', 'BBBDBBB', '.BBBBB.'],
  },
  motorboat: {
    length: 5,
    width: 2,
    speed: 1.6,
    paints: [P.white, P.white, P.red, P.graphite, P.orange],
    mini: ['◊', '◊'],
    // A canopy, a windscreen, and a light at the bow.
    plan: ['BBBRRGBB.', 'BBBRRGBBH', 'BBBRRGBB.'],
  },
  banca: {
    length: 7,
    width: 3.2,
    speed: 1.2,
    paints: [P.white, P.white, P.red, P.yellow, P.orange, P.cream],
    mini: ['◊', '◊'],
    // A slender painted hull under a canopy, with outriggers on booms either side.
    plan: ['..RRRRRRRR..', '...B....B...', 'BAABRRRRBAAH', '...B....B...', '..RRRRRRRR..'],
  },
  locomotive: {
    length: 14,
    width: 2.8,
    speed: 1,
    paints: TRAIN_PAINTS,
    mini: ['▬', '▮'],
    // A long hood behind the cab: roof vents down the middle, the cab's windows and lamps at
    // the front.
    plan: ['TDBBBBBBBBBBGGBH', 'DDRRDDRRDDRRRGBB', 'DDRRDDRRDDRRRGBB', 'TDBBBBBBBBBBGGBH'],
  },
  coach: {
    length: 18,
    width: 2.8,
    speed: 1,
    paints: TRAIN_PAINTS,
    mini: ['▬', '▮'],
    // Windows down both sides of a long roof, the couplings at the ends.
    plan: ['BBGGBGGBGGBGGBGGBB', 'DRRRRRRRRRRRRRRRRD', 'DRRRRRRRRRRRRRRRRD', 'BBGGBGGBGGBGGBGGBB'],
  },
  pagoda: {
    length: 14,
    width: 7,
    speed: 1,
    paints: [P.white, P.cream, P.yellow],
    mini: ['◊', '◊'],
    // A tiered, decorated canopy around the shrine, ringed with lights that glow at dusk.
    plan: [
      '..AAAAAAAAAA..',
      '.ARRRRRRRRRRA.',
      'ARRBBHHHHBBRRA',
      'ARRBHAAAAHBRRH',
      'ARRBBHHHHBBRRA',
      '.ARRRRRRRRRRA.',
      '..AAAAAAAAAA..',
    ],
  },
  voyador: {
    length: 12,
    width: 1.6,
    speed: 1,
    // The paddlers' team colors.
    paints: [P.yellow, P.red, P.white, P.orange, P.purple, P.pink],
    mini: ['◊', '◊'],
    // Paddlers down both sides of a long hull, a lamp at the bow.
    plan: ['.BBBBBBBBBBBBBB.', 'RRRRRRRRRRRRRRRH', '.BBBBBBBBBBBBBB.'],
  },
  baroto: {
    length: 4.5,
    width: 0.9,
    speed: 1,
    // Wood tones.
    paints: [P.cream, P.orange, P.maroon],
    mini: ['◊', '◊'],
    // A dugout canoe, pointed at both ends, with one paddler.
    plan: ['RBBBDBBR'],
  },
  sailboat: {
    length: 5,
    width: 2,
    speed: 1,
    paints: [P.white, P.red, P.yellow, P.orange],
    mini: ['◊', '◊'],
    // A small hull under a sail in a second color.
    plan: ['.BBBBBB.', 'BBAAAABB', '.BBBBBB.'],
  },
  cart: {
    length: 1.8,
    width: 1,
    speed: 0,
    paints: [P.red, P.blue, P.yellow, P.orange, P.green, P.white, P.sky],
    mini: [STALL_GLYPH, STALL_GLYPH],
    // An awning striped in its paint and a second color, its handles and wheels, and a lantern
    // that glows from dusk.
    plan: ['DARARAD', 'DRARARH', 'DARARAD'],
  },
  carabao: {
    length: 2.6,
    width: 1.3,
    speed: 0,
    // Slate grey to near black.
    paints: [P.graphite, P.graphite, P.silver],
    mini: ['▪', '▪'],
    // A broad back, its head in front with horns sweeping out to both sides (trim); no lights.
    plan: ['......D.', '.BBBBB..', 'BBBBBBBB', '.BBBBB..', '......D.'],
  },
};

/** Lines over the water (ropes, poles), by direction on screen: across, up and down, rising, falling. */
export const LINE_GLYPHS = { across: '─', upDown: '│', rising: '╱', falling: '╲' } as const;
/** The pennant at the top of a pole. */
export const PENNANT_GLYPH = '¶';

/** Every glyph vehicles, boats, and their lines draw with, for the map atlas (theme.ts `mapGlyphs`). */
export function vehicleGlyphs(): string[] {
  const out = new Set<string>([
    ...Object.values(PART_GLYPHS),
    ...Object.values(LINE_GLYPHS),
    PENNANT_GLYPH,
  ]);
  for (const spec of Object.values(VEHICLES)) for (const g of spec.mini) out.add(g);
  return [...out];
}

/** The part at (`u` along from the back, `v` across from the left), both 0–1, or null. */
export function planPart(spec: VehicleSpec, u: number, v: number): VehiclePart | null {
  const { plan } = spec;
  const row = plan[Math.min(plan.length - 1, Math.max(0, Math.floor(v * plan.length)))]!;
  const letter = row[Math.min(row.length - 1, Math.max(0, Math.floor(u * row.length)))]!;
  return planLetters[letter] ?? null;
}

/** Once a vehicle is this many cells long on screen, it is drawn from its plan. */
export const STAMP_MIN_CELLS = 2;

/** What a traffic mix is set for: road classes, rivers, and parked vehicles. */
export type MixKey = TrafficRoad | 'river' | 'canal' | 'parked';
const MIX_KEYS: readonly MixKey[] = [...TRAFFIC_ROADS, 'river', 'canal', 'parked'];

/** A city without a traffic mix gets this one, which fits most places. */
export const DEFAULT_TRAFFIC: Readonly<Record<MixKey, Partial<Record<CraftType, number>>>> = {
  road_major: { car: 50, motorcycle: 25, truck: 15, bus: 10 },
  road_mid: { car: 50, motorcycle: 30, truck: 10, bus: 5, bicycle: 5 },
  road_minor: { car: 45, motorcycle: 40, bicycle: 15 },
  river: { motorboat: 60, rowboat: 40 },
  canal: { rowboat: 60, banca: 40 },
  parked: { car: 85, motorcycle: 15 },
};

/** The mix a line's vehicles or boats come from. */
export const trafficRoadFor: Readonly<Partial<Record<LifeLine, MixKey>>> = {
  [LifeLine.roadMajor]: 'road_major',
  [LifeLine.roadMid]: 'road_mid',
  [LifeLine.roadMinor]: 'road_minor',
  [LifeLine.river]: 'river',
  [LifeLine.canal]: 'canal',
};

/** Per mix key, the types with a weight above 0 and their share of 0–1 (cumulative). */
export type ResolvedTraffic = Readonly<Record<MixKey, readonly [CraftType, number][]>>;

/** A city's mix over the default: each key it sets replaces the default's. */
export function resolveTraffic(mix: TrafficMix = {}): ResolvedTraffic {
  const out = {} as Record<MixKey, [CraftType, number][]>;
  for (const key of MIX_KEYS) {
    const weights = Object.entries(mix[key] ?? DEFAULT_TRAFFIC[key]).filter(
      (entry): entry is [CraftType, number] => (entry[1] ?? 0) > 0,
    );
    const total = weights.reduce((sum, [, w]) => sum + w, 0);
    let running = 0;
    out[key] = weights.map(([type, w]) => [type, (running += w / total)]);
  }
  return out;
}

/** A type from a mix's cumulative shares, for `r` in [0, 1). */
export function pickVehicle(shares: readonly [CraftType, number][], r: number): CraftType {
  for (const [type, upTo] of shares) if (r < upTo) return type;
  return shares[shares.length - 1]?.[0] ?? 'car';
}
