/**
 * People and animals of the harvest (SPEC.md §4): rakers on the drying strips, ducks on harvested
 * paddies, smoke from straw piles. All are stateless functions of a shared time and a world-anchored
 * hash: no random stream advances for them, every visitor sees the same at the same moment, and
 * nothing here can move an existing agent.
 */
import {
  metersPerUnit,
  TILE_EXTENT,
  tileToLngLat,
  utilitySeed,
  type HarvestNow,
  type TileAddress,
} from '@atlas/shared';
import type { TilePoint } from '../raster/geometry';
import { BirdPose } from './birds';
import { PALAY_SHOW_SHARE } from './config';
import { sample } from './exhaust';
import { unpackFootprints, type LifeGeometry } from './geometry';
import { DRYING_STRIDE, insideRings } from './palay';
import type { VisibleAgent } from './simulate';
import { Paint, VEHICLES } from './vehicles';

export const FIELD_LIFE = {
  /** Lattice cells across the world's width: z15 tiles / 10, about 120 m a side in the tropics. */
  lattice: 2 ** 15 * 10,
  /** Share of lattice points on a field that keep a flock, or a burning pile. */
  flockShare: 0.08,
  pileShare: 0.03,
  /** A flock wanders only a field this big, or the small mapped fragments fill up. */
  minFieldHectares: 1,
  flockSize: [12, 30],
  /** How far from their lattice point ducks wander, meters, and how fast they circle it. */
  flockRadius: 20,
  flockTurn: [0.01, 0.03],
  maxDucks: 60,
  /** A raker's walk along a strip and back, seconds; a pause at each end takes this share. */
  rakePeriod: [30, 60],
  rakePause: 0.05,
  smokeParticles: 16,
  smokeLength: 40,
  /** How far a plume spreads across the wind by its end, meters. */
  smokeSpread: 10,
  smokeLife: 40,
  maxSmoke: 48,
} as const;

export const RAKER_LABEL = 'Person raking palay (simulated)';
export const EMBER_LABEL = 'Burning straw (simulated)';
/** The pale `twoStroke` exhaust (life/puff-style.ts); a third color has no bit to spare. */
const SMOKE_KIND = 1;

export type FieldTile = { tile: TileAddress; geo: LifeGeometry };
export type FieldInput = {
  tiles: readonly FieldTile[];
  harvest: HarvestNow;
  /** Shared seconds: the same city moment gives the same scene to every visitor. */
  time: number;
  /** The way the wind blows, a unit vector in tile axes (x east, y south). */
  wind: readonly [number, number];
  /** How much of the day's birds are out (config.ts `activityLevels`). */
  birds: number;
  center: readonly [number, number];
  bounds?: readonly [number, number, number, number] | undefined;
  /** Share of people to show (quality's `crowd`). */
  crowd: number;
  /** Whether a tile should draw at this point (mixed-zoom tiles cover each other). */
  owns?: (tile: FieldTile, p: TilePoint) => boolean;
};
export type FieldFrame = { agents: VisibleAgent[]; puffs: number[] };

type Field = { rings: TilePoint[][]; box: readonly number[]; hectares: number };
type Duck = { way: number; turn: number; phase: number; radius: number };
type Site = {
  x: number;
  y: number;
  seed: number;
  rank: number;
  lng: number;
  lat: number;
  /** A flock's hashes, worked out once: a duck's place is all that changes with time. */
  ducks: Duck[] | undefined;
};
type Sites = { fields: Field[]; flocks: Site[]; pile: Site | undefined };

const ringArea = (ring: readonly TilePoint[]) => {
  let doubled = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    doubled += ring[j]!.x * ring[i]!.y - ring[i]!.x * ring[j]!.y;
  return Math.abs(doubled) / 2;
};

const inFields = (fields: readonly Field[], p: TilePoint) =>
  fields.some(
    ({ rings, box }) =>
      p.x >= box[0]! && p.x <= box[2]! && p.y >= box[1]! && p.y <= box[3]! && insideRings(rings, p),
  );

const siteCache = new WeakMap<LifeGeometry, Sites>();
/** A tile's farmland and the lattice points that keep a flock or a pile, once per tile. */
function sitesOf({ tile, geo }: FieldTile): Sites {
  let sites = siteCache.get(geo);
  if (sites) return sites;
  const meters = metersPerUnit(tile);
  const fields = unpackFootprints(geo.fields)
    .filter((field) => field.kind === 'farmland')
    .map(({ rings }): Field => {
      const box = [Infinity, Infinity, -Infinity, -Infinity];
      for (const { x, y } of rings[0] ?? []) {
        box[0] = Math.min(box[0]!, x);
        box[1] = Math.min(box[1]!, y);
        box[2] = Math.max(box[2]!, x);
        box[3] = Math.max(box[3]!, y);
      }
      const area = rings.reduce(
        (sum, ring, i) => sum + (i === 0 ? ringArea(ring) : -ringArea(ring)),
        0,
      );
      return { rings, box, hectares: (area * meters * meters) / 10_000 };
    });
  const flocks: Site[] = [];
  let pile: Site | undefined;
  const qualifying = fields.filter((field) => field.hectares >= FIELD_LIFE.minFieldHectares);
  if (qualifying.length) {
    const cell = (TILE_EXTENT * 2 ** tile.z) / FIELD_LIFE.lattice;
    const perTile = Math.round(TILE_EXTENT / cell);
    for (let row = 0; row < perTile; row++)
      for (let col = 0; col < perTile; col++) {
        const key = `${tile.x * perTile + col}/${tile.y * perTile + row}`;
        const seed = utilitySeed(`field-life:${key}`);
        const rank = sample(seed, 0, 1);
        if (rank >= FIELD_LIFE.flockShare) continue;
        // Off the lattice's own lines, so flocks don't stand in rows.
        const p = {
          x: (col + 0.25 + sample(seed, 0, 2) * 0.5) * cell,
          y: (row + 0.25 + sample(seed, 0, 3) * 0.5) * cell,
        };
        if (!inFields(qualifying, p)) continue;
        const [lng, lat] = tileToLngLat(tile, p);
        const site: Site = { ...p, seed, rank, lng, lat, ducks: undefined };
        flocks.push(site);
        // One pile a tile: the lowest rank under the stricter share.
        if (rank < FIELD_LIFE.pileShare && (!pile || rank < pile.rank)) pile = site;
      }
  }
  sites = { fields, flocks, pile };
  siteCache.set(geo, sites);
  return sites;
}

const inBounds = (bounds: FieldInput['bounds'], lng: number, lat: number) =>
  !bounds || (lng >= bounds[0] && lng <= bounds[2] && lat >= bounds[1] && lat <= bounds[3]);

/** Back and forth along 0–1 with a pause at each end, over one period's phase in 0–1. */
function rakeAlong(phase: number): { at: number; heading: 1 | -1; still: boolean } {
  const pause = FIELD_LIFE.rakePause;
  const walk = 0.5 - pause;
  if (phase < walk) return { at: phase / walk, heading: 1, still: false };
  if (phase < 0.5) return { at: 1, heading: -1, still: true };
  if (phase < 0.5 + walk) return { at: 1 - (phase - 0.5) / walk, heading: -1, still: false };
  return { at: 0, heading: 1, still: true };
}

/** One person on each strip in use, who stays for as long as the palay lies spread. */
function rakers(input: FieldInput, out: VisibleAgent[]) {
  const { harvest, time, crowd, bounds } = input;
  if (!harvest.spread) return;
  const share = harvest.drying * PALAY_SHOW_SHARE;
  for (const entry of input.tiles) {
    const drying = entry.geo.drying;
    if (!drying) continue;
    const perMeter = 1 / metersPerUnit(entry.tile);
    for (let i = 0; i < drying.length; i += DRYING_STRIDE) {
      const hash = drying[i + 5]!;
      if (hash >= share) continue;
      // The crowd knob drops the same rakers each time.
      if (hash / share >= crowd) continue;
      const seed = Math.floor(hash * 0x100000000);
      const period =
        FIELD_LIFE.rakePeriod[0] +
        (FIELD_LIFE.rakePeriod[1] - FIELD_LIFE.rakePeriod[0]) * sample(seed, 0, 1);
      const offset = sample(seed, 0, 2);
      const { at, heading, still } = rakeAlong((time / period + offset) % 1);
      const x0 = drying[i]!,
        y0 = drying[i + 1]!,
        x1 = drying[i + 2]!,
        y1 = drying[i + 3]!;
      const p = { x: x0 + (x1 - x0) * at, y: y0 + (y1 - y0) * at };
      if (input.owns && !input.owns(entry, p)) continue;
      const [lng, lat] = tileToLngLat(entry.tile, p);
      if (!inBounds(bounds, lng, lat)) continue;
      const length = Math.hypot(x1 - x0, y1 - y0) || 1;
      out.push({
        kind: 'person',
        lng,
        lat,
        ahead: tileToLngLat(entry.tile, {
          x: p.x + ((x1 - x0) / length) * heading * perMeter,
          y: p.y + ((y1 - y0) / length) * heading * perMeter,
        }),
        flap: still ? 0 : Math.floor(time * 2 + offset * 8) & 1,
        fieldLabel: RAKER_LABEL,
      });
    }
  }
}

/** Sites nearest the view's center first, ties by their own hash, whatever order tiles came in. */
function nearestSites(
  input: FieldInput,
  pick: (sites: Sites) => readonly Site[],
): { entry: FieldTile; site: Site; lng: number; lat: number }[] {
  const [cx, cy] = input.center;
  return input.tiles
    .flatMap((entry) =>
      pick(sitesOf(entry)).map((site) => ({
        entry,
        site,
        lng: site.lng,
        lat: site.lat,
        d: (site.lng - cx) ** 2 + (site.lat - cy) ** 2,
      })),
    )
    .sort((a, b) => a.d - b.d || a.site.seed - b.site.seed);
}

/** The tile drawing at this world point, and the point in its own units. */
function tileAt(
  from: FieldTile,
  p: TilePoint,
  tiles: () => ReadonlyMap<string, FieldTile>,
): { entry: FieldTile; p: TilePoint } | undefined {
  const dx = Math.floor(p.x / TILE_EXTENT),
    dy = Math.floor(p.y / TILE_EXTENT);
  if (dx === 0 && dy === 0) return { entry: from, p };
  const entry = tiles().get(`${from.tile.z}/${from.tile.x + dx}/${from.tile.y + dy}`);
  return entry && { entry, p: { x: p.x - dx * TILE_EXTENT, y: p.y - dy * TILE_EXTENT } };
}

function flockOf(seed: number, perMeter: number): Duck[] {
  const [small, large] = FIELD_LIFE.flockSize;
  const [slow, fast] = FIELD_LIFE.flockTurn;
  const size = small + Math.floor((large - small + 1) * sample(seed, 0, 5));
  return Array.from({ length: size }, (_, i) => {
    const way = sample(seed, i, 6) < 0.5 ? -1 : 1;
    return {
      way,
      turn: way * (slow + (fast - slow) * sample(seed, i, 7)),
      phase: 2 * Math.PI * sample(seed, i, 8),
      radius: FIELD_LIFE.flockRadius * Math.sqrt(sample(seed, i, 9)) * perMeter,
    };
  });
}

/** Flocks on the harvested paddies by day, each duck kept to the field by the tile it stands in. */
function ducks(input: FieldInput, out: VisibleAgent[]) {
  const { harvest, time, birds, bounds, crowd } = input;
  if (harvest.ducks <= 0 || birds <= 0) return;
  // Only a duck over a tile's edge asks.
  let known: Map<string, FieldTile> | undefined;
  const byKey = () =>
    (known ??= new Map(input.tiles.map((t) => [`${t.tile.z}/${t.tile.x}/${t.tile.y}`, t])));
  // A flock's reach in degrees, generously: 1° is at least 90 km along either axis here.
  const reach = FIELD_LIFE.flockRadius / 90_000;
  let drawn = 0;
  for (const { entry, site } of nearestSites(input, (sites) => sites.flocks)) {
    if (drawn >= FIELD_LIFE.maxDucks) return;
    // They come out and go home a flock at a time, as the day's birds do.
    if (sample(site.seed, 0, 4) >= birds * harvest.ducks * crowd) continue;
    if (
      bounds &&
      (site.lng < bounds[0] - reach ||
        site.lng > bounds[2] + reach ||
        site.lat < bounds[1] - reach ||
        site.lat > bounds[3] + reach)
    )
      continue;
    const perMeter = 1 / metersPerUnit(entry.tile);
    const flock = (site.ducks ??= flockOf(site.seed, perMeter));
    for (let i = 0; i < flock.length && drawn < FIELD_LIFE.maxDucks; i++) {
      const { way, turn, phase, radius } = flock[i]!;
      const angle = phase + time * turn;
      const world = { x: site.x + Math.cos(angle) * radius, y: site.y + Math.sin(angle) * radius };
      const here = tileAt(entry, world, byKey);
      if (!here || !inFields(sitesOf(here.entry).fields, here.p)) continue;
      if (input.owns && !input.owns(here.entry, here.p)) continue;
      const [lng, lat] = tileToLngLat(here.entry.tile, here.p);
      if (!inBounds(bounds, lng, lat)) continue;
      out.push({
        kind: 'bird',
        lng,
        lat,
        ahead: tileToLngLat(here.entry.tile, {
          x: here.p.x - Math.sin(angle) * way * perMeter,
          y: here.p.y + Math.cos(angle) * way * perMeter,
        }),
        flap: 0,
        bird: { species: 'duck', pose: BirdPose.perched },
      });
      drawn++;
    }
  }
}

/** Straw piles in the afternoon, each an ember under a plume blowing downwind. */
function smoke(input: FieldInput, out: FieldFrame) {
  const { harvest, time, wind, bounds, crowd } = input;
  if (!harvest.burning) return;
  const [wx, wy] = wind;
  let particles = 0;
  for (const { entry, site, lng, lat } of nearestSites(input, (sites) =>
    sites.pile ? [sites.pile] : [],
  )) {
    if (particles + FIELD_LIFE.smokeParticles > FIELD_LIFE.maxSmoke) return;
    if (sample(site.seed, 0, 10) >= crowd) continue;
    if (input.owns && !input.owns(entry, site)) continue;
    const perMeter = 1 / metersPerUnit(entry.tile);
    let shown = false;
    for (let i = 0; i < FIELD_LIFE.smokeParticles; i++) {
      const age =
        (time / FIELD_LIFE.smokeLife + i / FIELD_LIFE.smokeParticles + sample(site.seed, 0, 11)) %
        1;
      const along = age * FIELD_LIFE.smokeLength * perMeter;
      const across = (sample(site.seed, i, 12) - 0.5) * age * FIELD_LIFE.smokeSpread * perMeter;
      const [plng, plat] = tileToLngLat(entry.tile, {
        x: site.x + wx * along - wy * across,
        y: site.y + wy * along + wx * across,
      });
      if (!inBounds(bounds, plng, plat)) continue;
      // No owner: smoke isn't an exhaust, so no vehicle needs to be stamped for it.
      out.puffs.push(-1, plng, plat, age, SMOKE_KIND);
      particles++;
      shown = true;
    }
    if (shown || inBounds(bounds, lng, lat))
      out.agents.push({
        kind: 'person',
        lng,
        lat,
        flap: 0,
        prop: 'ball',
        paint: Paint.orange,
        fieldLabel: EMBER_LABEL,
      });
  }
}

/**
 * What a farmer who owns a carabao leads now: while the stage calls for them, a stable share
 * lead a hand tractor instead, then go back to the same animal. Spawning never changes, so no
 * random stream moves.
 */
export function workAnimal(
  rank: number,
  carabao: number,
  tractors: number,
): { vehicle: 'carabao' | 'hand-tractor'; paint: number } {
  const seed = Math.floor(rank * 0x100000000);
  if (sample(seed, 0, 13) >= tractors) return { vehicle: 'carabao', paint: carabao };
  const paints = VEHICLES['hand-tractor'].paints;
  return {
    vehicle: 'hand-tractor',
    paint: paints[Math.floor(sample(seed, 0, 14) * paints.length)]!,
  };
}

/** Everything the harvest adds to this frame. */
export function fieldLife(input: FieldInput): FieldFrame {
  const frame: FieldFrame = { agents: [], puffs: [] };
  rakers(input, frame.agents);
  ducks(input, frame.agents);
  smoke(input, frame);
  return frame;
}
