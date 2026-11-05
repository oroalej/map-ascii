/**
 * Birds' daily commute (SPEC.md §4): skeins of egrets to their roost at dusk and out at dawn, bats out
 * at dusk and home before dawn. Like the harvest's actors (life/field-life.ts), they are stateless
 * functions of a shared time and a hash: no random stream advances for them, every visitor sees the
 * same at the same moment, and nothing here can move an existing agent.
 */
import { minutesOf, type FlywayConfig, type FlywaySpecies } from '@atlas/shared';
import { BIRD_SPECIES, BirdPose } from './birds';
import { sample } from './exhaust';
import type { VisibleAgent } from './simulate';

export const FLYWAY = {
  maxBirds: 120,
  /** Skeins flying each bearing at once, and how long one takes off after its trip, as a share. */
  streams: 3,
  rest: [0.15, 0.6],
  skein: [6, 14],
  /** How far apart a skein's birds fly along its line, and off it to either side, m. */
  spacing: [14, 24],
  sway: 10,
} as const;

/** Meters in a degree of latitude, for flights short enough that the earth reads as flat. */
const METERS_PER_DEGREE = 111_320;

export const FLYWAY_LABELS: Readonly<Record<FlywaySpecies, Record<'home' | 'out', string>>> = {
  egret: {
    home: 'Egrets flying to roost (simulated)',
    out: 'Egrets leaving the roost (simulated)',
  },
  bat: { home: 'Bats returning to roost (simulated)', out: 'Bats leaving the roost (simulated)' },
};

/** Which way a species flies in a window: egrets come home at dusk, bats at dawn. */
export const flyingHome = (species: FlywaySpecies, window: 'dusk' | 'dawn') =>
  species === 'egret' ? window === 'dusk' : window === 'dawn';

export type FlywayInput = {
  flyways: readonly FlywayConfig[];
  /** Minutes past local midnight: which windows are open. */
  minutes: number;
  /** Shared seconds, which keep them flying at a fixed hour too. */
  time: number;
  center: readonly [number, number];
  bounds?: readonly [number, number, number, number] | undefined;
  /** Share of skeins to show (quality's `crowd`). */
  crowd: number;
};

type Skein = {
  flyway: FlywayConfig;
  home: boolean;
  /** The line it flies, meters from `from`. */
  from: readonly [number, number];
  east: number;
  north: number;
  length: number;
  head: number;
  seed: number;
  size: number;
  spacing: number;
  d: number;
};

/** Every skein in the air now: its release fell within its window, and it hasn't landed. */
function skeinsNow(input: FlywayInput): Skein[] {
  const { flyways, minutes, time, center, crowd } = input;
  const out: Skein[] = [];
  for (let f = 0; f < flyways.length; f++) {
    const flyway = flyways[f]!;
    const speed = BIRD_SPECIES[flyway.species].speed;
    const [lng, lat] = flyway.roost;
    const lngScale = METERS_PER_DEGREE * Math.cos((lat * Math.PI) / 180);
    const longest = FLYWAY.skein[1] * FLYWAY.spacing[1];
    const trip = (flyway.distance_m + longest) / speed;
    for (const window of ['dusk', 'dawn'] as const) {
      const [open, close] = flyway[window];
      const from = minutesOf(open);
      const to = minutesOf(close);
      // Outside its window and the last landing, a flyway costs this comparison.
      if (minutes < from || minutes >= to + trip / 60) continue;
      const home = flyingHome(flyway.species, window);
      for (let b = 0; b < flyway.bearings.length; b++) {
        const bearing = (flyway.bearings[b]! * Math.PI) / 180;
        const outEast = Math.sin(bearing),
          outNorth = Math.cos(bearing);
        const far: [number, number] = [
          lng + (outEast * flyway.distance_m) / lngScale,
          lat + (outNorth * flyway.distance_m) / METERS_PER_DEGREE,
        ];
        for (let s = 0; s < FLYWAY.streams; s++) {
          const stream =
            (Math.imul(f + 1, 0x9e3779b1) ^
              Math.imul(b + 1, 0x85ebca6b) ^
              Math.imul(s + 1, 0xc2b2ae35) ^
              (window === 'dusk' ? 0 : 0x27d4eb2f)) >>>
            0;
          const period =
            trip * (1 + FLYWAY.rest[0] + (FLYWAY.rest[1] - FLYWAY.rest[0]) * sample(stream, 0, 1));
          const phase = time / period + sample(stream, 0, 2);
          const cycle = Math.floor(phase);
          const age = (phase - cycle) * period;
          if (age >= trip) continue;
          // When this one set off: it flies on past the window's end, and none sets off after.
          const release = minutes - age / 60;
          if (release < from || release >= to) continue;
          const seed = Math.floor(sample(stream, cycle, 3) * 0x100000000);
          if (sample(seed, 0, 4) >= crowd) continue;
          const [small, large] = FLYWAY.skein;
          const start = home ? far : flyway.roost;
          const way = home ? -1 : 1;
          const head = age * speed;
          const at = [
            start[0] + (way * outEast * head) / lngScale,
            start[1] + (way * outNorth * head) / METERS_PER_DEGREE,
          ] as const;
          out.push({
            flyway,
            home,
            from: start,
            east: way * outEast,
            north: way * outNorth,
            length: flyway.distance_m,
            head,
            seed,
            size: small + Math.floor((large - small + 1) * sample(seed, 0, 5)),
            spacing:
              FLYWAY.spacing[0] + (FLYWAY.spacing[1] - FLYWAY.spacing[0]) * sample(seed, 0, 6),
            d: (at[0] - center[0]) ** 2 + (at[1] - center[1]) ** 2,
          });
        }
      }
    }
  }
  return out.sort((a, b) => a.d - b.d || a.seed - b.seed);
}

/** The birds on screen, nearest skein first, up to the cap. */
export function flywayBirds(input: FlywayInput): VisibleAgent[] {
  const { time, bounds } = input;
  const out: VisibleAgent[] = [];
  for (const skein of skeinsNow(input)) {
    const { flyway, home, from, east, north, length, head, seed, size, spacing } = skein;
    const spec = BIRD_SPECIES[flyway.species];
    const lngScale = METERS_PER_DEGREE * Math.cos((from[1] * Math.PI) / 180);
    const label = FLYWAY_LABELS[flyway.species][home ? 'home' : 'out'];
    const aheadLng = east / lngScale,
      aheadLat = north / METERS_PER_DEGREE;
    for (let i = 0; i < size; i++) {
      if (out.length >= FLYWAY.maxBirds) return out;
      const along = head - i * spacing * (0.75 + 0.5 * sample(seed, i, 7));
      // Not yet off, or already down.
      if (along < 0 || along > length) continue;
      const beside = (sample(seed, i, 8) - 0.5) * 2 * FLYWAY.sway;
      const lng = from[0] + (east * along + north * beside) / lngScale;
      const lat = from[1] + (north * along - east * beside) / METERS_PER_DEGREE;
      if (bounds && (lng < bounds[0] || lng > bounds[2] || lat < bounds[1] || lat > bounds[3]))
        continue;
      const flap = Math.floor(time * spec.flap + sample(seed, i, 9) * 2) & 1;
      out.push({
        kind: 'bird',
        lng,
        lat,
        ahead: [lng + aheadLng, lat + aheadLat],
        flap,
        bird: {
          species: flyway.species,
          pose: flap === 1 ? BirdPose.raised : BirdPose.spread,
        },
        fieldLabel: label,
      });
    }
  }
  return out;
}
