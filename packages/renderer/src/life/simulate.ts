/**
 * The life layer's simulation (SPEC.md §4 "Life layer"): vehicles, people, and boats moving
 * along the lines of the tiles on screen, and flocks of birds circling over parks, trees, and
 * water. Agents live in tile units, per tile; a tile's agents are spawned from a seed made of its
 * key when it comes into view, so the same tile always starts with the same agents. Pure TS: the
 * renderer projects the agents onto the cell grid (passes.ts `lifePass`).
 */
import { bandVisibility } from '@atlas/shared';
import { EXTENT, metersPerUnit, tileToLngLat } from '../raster/geometry';
import type { TileId } from '../tiles';
import {
  activity,
  BIRDS,
  LANE_OFFSET_M,
  LIFE_ZOOM,
  MAX_STEP_S,
  MAX_TILE_AGENTS,
  MAX_VISIBLE_AGENTS,
  PERSON_PAUSE,
  PERSON_TURN_CHANCE,
  spawnRules,
  usableLines,
  type AgentKind,
} from './config';
import type { LifeGeometry, LifeLine } from './geometry';

/** A deterministic random number generator (mulberry32), 0 ≤ n < 1. */
export function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A string's FNV-1a hash, for seeds. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

const between = (rng: () => number, [lo, hi]: readonly [number, number]) => lo + (hi - lo) * rng();

/** Something that moves along lines: a vehicle, a person, or a boat. */
export type Mover = {
  kind: Exclude<AgentKind, 'bird'>;
  line: number;
  /** The vertex it last passed (an index into the tile's `coords` pairs). */
  from: number;
  /** Which way along the line it goes. */
  dir: 1 | -1;
  /** How far it is past `from`, in tile units. */
  d: number;
  /** Tile units per second. */
  speed: number;
  /** Seconds left standing still (people). */
  pause: number;
  /** Shows while this is below the kind's activity (config.ts `activity`). */
  rank: number;
  /** Position and heading (a unit vector), in tile units. */
  x: number;
  y: number;
  hx: number;
  hy: number;
};

export type Bird = { ox: number; oy: number; phase: number };

export type Flock = {
  /** The flock's center, in tile units. */
  x: number;
  y: number;
  /** The roost it circles (an index into `roosts` pairs). */
  roost: number;
  /** Circling: angle (radians), radius (tile units), and seconds until it moves on. */
  angle: number;
  radius: number;
  stay: number;
  rank: number;
  birds: Bird[];
};

/** The agents of one tile. */
export class TileLife {
  readonly movers: Mover[] = [];
  readonly flocks: Flock[] = [];
  /** Tile units per meter. */
  readonly perMeter: number;
  private readonly rng: () => number;
  /** Line ends by position: packed position → line * 2 + (0 start, 1 end). */
  private readonly ends = new Map<number, number[]>();
  private time = 0;

  constructor(
    readonly tile: TileId,
    readonly geo: LifeGeometry,
    seed: number,
  ) {
    this.perMeter = 1 / metersPerUnit(tile);
    this.rng = random(seed);
    const lines = geo.kinds.length;
    for (let line = 0; line < lines; line++) {
      this.addEnd(this.first(line), line * 2);
      this.addEnd(this.last(line), line * 2 + 1);
    }
    for (let line = 0; line < lines; line++) this.spawnOn(line);
    this.spawnFlocks();
  }

  private first(line: number) {
    return this.geo.starts[line]!;
  }

  private last(line: number) {
    return this.geo.starts[line + 1]! - 1;
  }

  private endKey(vertex: number) {
    const x = Math.round(this.geo.coords[vertex * 2]!) + 32768;
    const y = Math.round(this.geo.coords[vertex * 2 + 1]!) + 32768;
    return x * 65536 + y;
  }

  private addEnd(vertex: number, code: number) {
    const key = this.endKey(vertex);
    const list = this.ends.get(key);
    if (list) list.push(code);
    else this.ends.set(key, [code]);
  }

  private segment(a: number, b: number) {
    const { coords } = this.geo;
    return Math.hypot(coords[b * 2]! - coords[a * 2]!, coords[b * 2 + 1]! - coords[a * 2 + 1]!);
  }

  private lineLength(line: number) {
    let length = 0;
    for (let v = this.first(line); v < this.last(line); v++) length += this.segment(v, v + 1);
    return length;
  }

  private spawnOn(line: number) {
    const rules = spawnRules[this.geo.kinds[line]! as LifeLine];
    const meters = this.lineLength(line) / this.perMeter;
    if (!rules || meters === 0) return;
    const { rng } = this;
    for (const rule of rules) {
      const count = Math.floor(meters / rule.spacing + rng());
      for (let i = 0; i < count && this.movers.length < MAX_TILE_AGENTS; i++) {
        const dir = rng() < 0.5 ? 1 : -1;
        const mover: Mover = {
          kind: rule.kind,
          line,
          from: dir === 1 ? this.first(line) : this.last(line),
          dir,
          d: 0,
          speed: between(rng, rule.speed) * this.perMeter,
          pause: 0,
          rank: rng(),
          x: 0,
          y: 0,
          hx: 1,
          hy: 0,
        };
        // Start somewhere along the line.
        this.advance(mover, rng() * this.lineLength(line), false);
        this.movers.push(mover);
      }
    }
  }

  private spawnFlocks() {
    const { rng, geo } = this;
    const roosts = geo.roosts.length / 2;
    const flocks = Math.min(BIRDS.flocksPerTile, roosts);
    for (let f = 0; f < flocks; f++) {
      const roost = Math.floor(rng() * roosts);
      const size = Math.round(between(rng, BIRDS.flockSize));
      const birds: Bird[] = [];
      for (let b = 0; b < size; b++) {
        const angle = rng() * 2 * Math.PI;
        const spread = between(rng, BIRDS.spread) * this.perMeter;
        birds.push({ ox: Math.cos(angle) * spread, oy: Math.sin(angle) * spread, phase: rng() });
      }
      this.flocks.push({
        x: geo.roosts[roost * 2]!,
        y: geo.roosts[roost * 2 + 1]!,
        roost,
        angle: rng() * 2 * Math.PI,
        radius: between(rng, BIRDS.orbit) * this.perMeter,
        stay: between(rng, BIRDS.stay),
        rank: rng(),
        birds,
      });
    }
  }

  /** Move a mover `distance` tile units along its lines, turning at junctions and dead ends. */
  private advance(m: Mover, distance: number, junctions = true) {
    const { coords } = this.geo;
    let left = distance;
    // Bounded, so zero-length segments can't loop forever.
    for (let guard = 0; guard < 256; guard++) {
      const to = m.from + m.dir;
      const length = this.segment(m.from, to);
      if (m.d + left < length) {
        m.d += left;
        break;
      }
      left -= length - m.d;
      m.d = 0;
      m.from = to;
      const atEnd = m.dir === 1 ? to === this.last(m.line) : to === this.first(m.line);
      if (atEnd) {
        if (junctions) this.turn(m);
        else m.dir = m.dir === 1 ? -1 : 1;
      }
    }
    const to = m.from + m.dir;
    const length = this.segment(m.from, to);
    const ax = coords[m.from * 2]!;
    const ay = coords[m.from * 2 + 1]!;
    if (length > 0) {
      m.hx = (coords[to * 2]! - ax) / length;
      m.hy = (coords[to * 2 + 1]! - ay) / length;
    }
    m.x = ax + m.hx * m.d;
    m.y = ay + m.hy * m.d;
  }

  /** At a line's end: carry on along another usable line that starts or ends here, else U-turn. */
  private turn(m: Mover) {
    const arrived = m.line * 2 + (m.dir === 1 ? 1 : 0);
    const usable = usableLines[m.kind];
    const options = (this.ends.get(this.endKey(m.from)) ?? []).filter(
      (code) => code !== arrived && usable.includes(this.geo.kinds[code >> 1]! as LifeLine),
    );
    if (options.length === 0) {
      m.dir = m.dir === 1 ? -1 : 1;
      return;
    }
    const code = options[Math.floor(this.rng() * options.length)]!;
    m.line = code >> 1;
    const fromStart = (code & 1) === 0;
    m.from = fromStart ? this.first(m.line) : this.last(m.line);
    m.dir = fromStart ? 1 : -1;
  }

  step(dt: number) {
    this.time += dt;
    const { rng } = this;
    for (const m of this.movers) {
      if (m.kind === 'person') {
        if (m.pause > 0) {
          m.pause -= dt;
          continue;
        }
        if (rng() < PERSON_PAUSE.chance * dt) {
          m.pause = between(rng, PERSON_PAUSE.seconds);
          continue;
        }
        if (rng() < PERSON_TURN_CHANCE * dt) {
          // Turn back: now heading for the vertex it was walking away from.
          const to = m.from + m.dir;
          m.d = this.segment(m.from, to) - m.d;
          m.from = to;
          m.dir = m.dir === 1 ? -1 : 1;
        }
      }
      this.advance(m, m.speed * dt);
    }
    this.stepFlocks(dt);
  }

  private stepFlocks(dt: number) {
    const { roosts } = this.geo;
    const count = roosts.length / 2;
    const speed = BIRDS.speed * this.perMeter;
    for (const flock of this.flocks) {
      flock.stay -= dt;
      if (flock.stay <= 0 && count > 1) {
        flock.roost = Math.floor(this.rng() * count);
        flock.stay = between(this.rng, BIRDS.stay);
      }
      // Circle the roost; the flock's center chases the point on the circle a little faster
      // than it moves, so it catches up after moving on to another roost.
      flock.angle += (speed / flock.radius) * dt;
      const tx = roosts[flock.roost * 2]! + Math.cos(flock.angle) * flock.radius;
      const ty = roosts[flock.roost * 2 + 1]! + Math.sin(flock.angle) * flock.radius;
      const dx = tx - flock.x;
      const dy = ty - flock.y;
      const distance = Math.hypot(dx, dy);
      const reach = Math.min(distance, speed * 1.4 * dt);
      if (distance > 0) {
        flock.x += (dx / distance) * reach;
        flock.y += (dy / distance) * reach;
      }
    }
  }

  /** Seconds simulated so far. */
  get elapsed() {
    return this.time;
  }
}

/** An agent to draw. */
export type VisibleAgent = {
  kind: AgentKind;
  lng: number;
  lat: number;
  /** A point a little ahead, for the heading on screen (movers only). */
  ahead?: [number, number];
  /** Birds: which wing glyph (0 or 1). */
  flap: number;
};

export type LifeTile = { key: string; tile: TileId; life: LifeGeometry };

/** Every tile's agents: kept in step with the tiles on screen. */
export class LifeWorld {
  private readonly tiles = new Map<string, TileLife>();

  /** Spawn agents for tiles that came into view and drop those of tiles that left it. */
  sync(tiles: readonly LifeTile[]) {
    const keep = new Set<string>();
    for (const { key, tile, life } of tiles) {
      keep.add(key);
      if (!this.tiles.has(key)) this.tiles.set(key, new TileLife(tile, life, hashString(key)));
    }
    for (const key of this.tiles.keys()) if (!keep.has(key)) this.tiles.delete(key);
  }

  step(dt: number) {
    const clamped = Math.min(MAX_STEP_S, Math.max(0, dt));
    if (clamped === 0) return;
    for (const tile of this.tiles.values()) tile.step(clamped);
  }

  get size() {
    return this.tiles.size;
  }

  /**
   * The agents to draw at `zoom` and time of day: those whose kind shows at the zoom and who
   * are out (config.ts `activity`), movers only inside their own tile (tiles overlap in their
   * buffers), at most `MAX_VISIBLE_AGENTS`, nearest `center` first.
   */
  visible(zoom: number, daylight: number, center: [number, number]): VisibleAgent[] {
    const shows = (kind: AgentKind) => bandVisibility(LIFE_ZOOM[kind], zoom) >= 1;
    const out: VisibleAgent[] = [];
    for (const life of this.tiles.values()) {
      const { tile, perMeter } = life;
      for (const m of life.movers) {
        if (!shows(m.kind) || m.rank >= activity(m.kind, daylight)) continue;
        if (m.x < 0 || m.x >= EXTENT || m.y < 0 || m.y >= EXTENT) continue;
        // Keep right: offset to the right of the heading (tile y points down).
        const lane = m.kind === 'vehicle' ? LANE_OFFSET_M * perMeter : 0;
        const x = m.x - m.hy * lane;
        const y = m.y + m.hx * lane;
        const [lng, lat] = tileToLngLat(tile, { x, y });
        const ahead = tileToLngLat(tile, { x: x + m.hx * perMeter, y: y + m.hy * perMeter });
        out.push({ kind: m.kind, lng, lat, ahead, flap: 0 });
      }
      if (!shows('bird')) continue;
      const birdsOut = activity('bird', daylight);
      for (const flock of life.flocks) {
        if (flock.rank >= birdsOut) continue;
        const wobble = life.elapsed * 0.8;
        for (const bird of flock.birds) {
          const cos = Math.cos(wobble + bird.phase * 6);
          const sin = Math.sin(wobble + bird.phase * 6);
          const [lng, lat] = tileToLngLat(tile, {
            x: flock.x + bird.ox * cos - bird.oy * sin,
            y: flock.y + bird.ox * sin + bird.oy * cos,
          });
          const flap = Math.floor(life.elapsed * BIRDS.flap + bird.phase * 2) & 1;
          out.push({ kind: 'bird', lng, lat, flap });
        }
      }
    }
    if (out.length <= MAX_VISIBLE_AGENTS) return out;
    const [cx, cy] = center;
    const distance = (a: VisibleAgent) => (a.lng - cx) ** 2 + (a.lat - cy) ** 2;
    return out.sort((a, b) => distance(a) - distance(b)).slice(0, MAX_VISIBLE_AGENTS);
  }
}
