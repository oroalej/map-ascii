/** Scratch belongs to one world. Only selected agents get heading and appearance arrays. */
import { bandVisibility } from '@atlas/shared';
import { EXTENT, lngLatToTile, tileToLngLat } from '../../src/raster/geometry';
import { BIRD_SPECIES, BirdPose } from '../../src/life/birds';
import { DOG, LIFE_ZOOM, MAX_VISIBLE_AGENTS, PARKED, PEOPLE, PERCH } from '../../src/life/config';
import type { Activity } from '../../src/life/config';
import { CAT } from '../../src/life/cats';
import type { PersonLook } from '../../src/life/people';
import type { LngLatBounds } from '../../src/life/procession';
import { trainCars } from '../../src/life/simulate';
import type {
  Flock,
  Gatherer,
  Mover,
  Parked,
  Stall,
  TileLife,
  VisibleAgent,
} from '../../src/life/simulate';

type Source = Mover | Stall | Gatherer | Parked | Flock | VisibleAgent;
type Candidate = {
  tag: 'mover' | 'stall' | 'gatherer' | 'parked' | 'standby' | 'bird' | 'ready';
  source: Source | null;
  life: TileLife | null;
  x: number;
  y: number;
  lng: number;
  lat: number;
  ordinal: number;
  distance: number;
  face: number;
  flap: number;
  pose: BirdPose;
};
const compare = (a: Candidate, b: Candidate) => a.distance - b.distance || a.ordinal - b.ordinal;

export class VisibleCandidates {
  private readonly pool: Candidate[] = [];
  private readonly heap: Candidate[] = [];
  private count = 0;

  add(
    tag: Candidate['tag'],
    life: TileLife,
    source: Source,
    x: number,
    y: number,
    position?: readonly [number, number],
  ) {
    const ordinal = this.count++;
    let c = this.pool[ordinal];
    if (!c)
      this.pool.push(
        (c = {
          tag,
          life: null,
          source: null,
          x: 0,
          y: 0,
          lng: 0,
          lat: 0,
          ordinal,
          distance: 0,
          face: 0,
          flap: 0,
          pose: BirdPose.spread,
        }),
      );
    c.tag = tag;
    c.life = life;
    c.source = source;
    c.x = x;
    c.y = y;
    [c.lng, c.lat] = position ?? tileToLngLat(life.tile, { x, y });
    return c;
  }

  finish(staged: VisibleAgent[], center: readonly [number, number], umbrellas: number) {
    const out = staged.slice(),
      heap = this.heap;
    try {
      if (this.count <= MAX_VISIBLE_AGENTS) {
        for (let i = 0; i < this.count; i++) out.push(materialize(this.pool[i]!, umbrellas));
      } else {
        for (let i = 0; i < this.count; i++) {
          const c = this.pool[i]!;
          c.distance = (c.lng - center[0]) ** 2 + (c.lat - center[1]) ** 2;
          if (heap.length < MAX_VISIBLE_AGENTS) {
            let k = heap.length;
            heap.push(c);
            while (k > 0) {
              const parent = (k - 1) >> 1;
              if (compare(heap[parent]!, c) >= 0) break;
              heap[k] = heap[parent]!;
              k = parent;
            }
            heap[k] = c;
          } else if (compare(c, heap[0]!) < 0) {
            let k = 0;
            while (k * 2 + 1 < heap.length) {
              let child = k * 2 + 1;
              if (child + 1 < heap.length && compare(heap[child + 1]!, heap[child]!) > 0) child++;
              if (compare(c, heap[child]!) >= 0) break;
              heap[k] = heap[child]!;
              k = child;
            }
            heap[k] = c;
          }
        }
        heap.sort(compare);
        for (const c of heap) out.push(materialize(c, umbrellas));
      }
      return out;
    } finally {
      // Keep storage, release tile/agent references so evicted tiles can be collected.
      for (let i = 0; i < this.count; i++) {
        this.pool[i]!.source = null;
        this.pool[i]!.life = null;
      }
      this.count = 0;
      heap.length = 0;
    }
  }
}

function look(g: Gatherer, umbrellas: number): PersonLook {
  const w = g.walker,
    shaded = w.figure === 'adult' && w.umbrella < umbrellas;
  return {
    figure: shaded ? 'umbrella' : w.figure,
    paint: shaded ? w.canopy : w.shirt,
    lateral: 0,
    back: 0,
    flap:
      g.pause > 0 || g.behavior === 'sit' ? 0 : (Math.floor(g.walked / PEOPLE.stride) + w.step) & 1,
  };
}

function materialize(c: Candidate, umbrellas: number): VisibleAgent {
  if (c.tag === 'ready') return c.source as VisibleAgent;
  const life = c.life!,
    { tile, perMeter } = life,
    { lng, lat, x, y } = c;
  // The tag records which collection supplied the pooled source.
  if (c.tag === 'bird') {
    const flock = c.source as Flock;
    return {
      kind: 'bird',
      lng,
      lat,
      ahead: tileToLngLat(tile, {
        x: x + Math.cos(c.face) * perMeter,
        y: y + Math.sin(c.face) * perMeter,
      }),
      flap: c.flap,
      bird: { species: flock.species, pose: c.pose },
    };
  }
  const source = c.source as Mover | Stall | Gatherer | Parked;
  const ahead = tileToLngLat(tile, { x: x + source.hx * perMeter, y: y + source.hy * perMeter });
  const side = () =>
    tileToLngLat(tile, { x: x - source.hy * perMeter, y: y + source.hx * perMeter });
  if (c.tag === 'mover') {
    const m = source as Mover;
    if (m.vehicle)
      return {
        kind: m.kind,
        lng,
        lat,
        ahead,
        side: side(),
        vehicle: m.vehicle,
        paint: m.paint,
        flap: 0,
      };
    if (m.group) {
      const stride = Math.floor((m.walked ?? 0) / PEOPLE.stride);
      return {
        kind: m.kind,
        lng,
        lat,
        ahead,
        flap: 0,
        people: m.group.map((w): PersonLook => ({
          figure: w.figure === 'adult' && w.umbrella < umbrellas ? 'umbrella' : w.figure,
          paint: w.figure === 'adult' && w.umbrella < umbrellas ? w.canopy : w.shirt,
          lateral: w.lateral,
          back: w.back,
          flap: m.pause > 0 ? 0 : (stride + w.step) & 1,
        })),
      };
    }
    if (m.kind === 'dog' || m.kind === 'cat') {
      const still = m.pause > 0 || life.scenes.still(m);
      const flap =
        m.kind === 'cat'
          ? still
            ? m.grooming
              ? 3
              : 2
            : Math.floor((m.walked ?? 0) / CAT.stride) & 1
          : still
            ? 0
            : Math.floor((m.walked ?? 0) / DOG.stride) & 1;
      return { kind: m.kind, lng, lat, ahead, paint: m.paint, flap };
    }
    return { kind: m.kind, lng, lat, ahead, flap: 0 };
  }
  if (c.tag === 'stall') {
    const s = source as Stall;
    return {
      kind: 'person',
      lng,
      lat,
      ahead,
      side: side(),
      vehicle: 'cart',
      covered: s.covered,
      paint: s.paint,
      flap: 0,
      people: [{ figure: 'adult', paint: s.shirt, lateral: s.side, back: 0, flap: 0 }],
    };
  }
  if (c.tag === 'gatherer') {
    const g = source as Gatherer,
      person = look(g, umbrellas);
    return g.carabao !== undefined
      ? {
          kind: 'person',
          lng,
          lat,
          ahead,
          side: side(),
          vehicle: 'carabao',
          paint: g.carabao,
          flap: 0,
          people: [{ ...person, lateral: 1 }],
        }
      : { kind: 'person', lng, lat, ahead, flap: 0, people: [person] };
  }
  const p = source as Parked;
  return {
    kind: c.tag === 'standby' ? 'train' : 'vehicle',
    lng,
    lat,
    ahead,
    side: side(),
    vehicle: p.vehicle,
    paint: p.paint,
    parked: true,
    flap: 0,
  };
}

export function collectVisible(
  candidates: VisibleCandidates,
  tiles: Iterable<TileLife>,
  zoom: number,
  levels: Activity,
  umbrellas: number,
  bounds: LngLatBounds | undefined,
  procession: boolean,
  staged: VisibleAgent[],
  center: [number, number],
) {
  const shows = (kind: keyof typeof LIFE_ZOOM) => bandVisibility(LIFE_ZOOM[kind], zoom) >= 1;
  for (const life of tiles) {
    const { tile, perMeter } = life;
    let inView = (_x: number, _y: number) => true;
    if (bounds) {
      const [west, south, east, north] = bounds,
        nw = lngLatToTile(tile, west, north),
        se = lngLatToTile(tile, east, south);
      const margin = 30 * perMeter;
      inView = (x, y) =>
        x >= nw.x - margin && x <= se.x + margin && y >= nw.y - margin && y <= se.y + margin;
    }
    for (const m of life.movers) {
      if (
        life.scenes.hidden(m) ||
        !shows(m.kind) ||
        m.rank >= levels[m.kind] ||
        (procession && m.kind === 'boat')
      )
        continue;
      if (m.x < 0 || m.x >= EXTENT || m.y < 0 || m.y >= EXTENT) continue;
      if (m.train) {
        for (const car of trainCars(life, m))
          candidates.add('ready', life, car, 0, 0, [car.lng, car.lat]);
        continue;
      }
      if (!inView(m.x, m.y)) continue;
      const lane = life.offsetOf(m) * perMeter;
      candidates.add('mover', life, m, m.x - m.hy * lane, m.y + m.hx * lane);
    }
    if (shows('person')) {
      for (const s of life.stalls) {
        if (
          s.open === false ||
          s.rank >= levels.person ||
          s.x < 0 ||
          s.x >= EXTENT ||
          s.y < 0 ||
          s.y >= EXTENT ||
          !inView(s.x, s.y)
        )
          continue;
        candidates.add('stall', life, s, s.x, s.y);
      }
      for (const g of life.gatherers) {
        if (g.rank >= levels.places[g.place] || !inView(g.x, g.y)) continue;
        candidates.add(
          'gatherer',
          life,
          g,
          g.x + (g.carabao !== undefined ? g.hx * 1.8 * perMeter : 0),
          g.y + (g.carabao !== undefined ? g.hy * 1.8 * perMeter : 0),
        );
      }
    }
    if (bandVisibility(PARKED.zoom, zoom) >= 1) {
      for (const p of life.parked) {
        if (p.x < 0 || p.x >= EXTENT || p.y < 0 || p.y >= EXTENT || !inView(p.x, p.y)) continue;
        candidates.add('parked', life, p, p.x, p.y);
      }
    }
    if (shows('train')) for (const p of life.standby) candidates.add('standby', life, p, p.x, p.y);
    if (!shows('bird')) continue;
    for (const flock of life.flocks) {
      const spec = BIRD_SPECIES[flock.species];
      if (flock.rank >= (spec.nocturnal ? levels.night : levels.bird) || !inView(flock.x, flock.y))
        continue;
      const wobble = life.elapsed * 0.8,
        sitting = flock.perched || flock.landed,
        heading = Math.atan2(flock.hy, flock.hx);
      const spread = flock.perched
        ? PERCH.spread / spec.spread[1]
        : flock.landed
          ? 1
          : 1 + (3 * flock.scatter) / PERCH.scatter;
      for (const bird of flock.birds) {
        const turn = sitting ? bird.phase * 6 : wobble + bird.phase * 6;
        const cos = Math.cos(turn) * spread,
          sin = Math.sin(turn) * spread;
        const c = candidates.add(
          'bird',
          life,
          flock,
          flock.x + bird.ox * cos - bird.oy * sin,
          flock.y + bird.ox * sin + bird.oy * cos,
        );
        c.flap = sitting ? 0 : Math.floor(life.elapsed * spec.flap + bird.phase * 2) & 1;
        c.pose = sitting ? BirdPose.perched : c.flap === 1 ? BirdPose.raised : BirdPose.spread;
        c.face = sitting ? bird.phase * 2 * Math.PI : heading + (bird.phase - 0.5) * 0.6;
      }
    }
  }
  return candidates.finish(staged, center, umbrellas);
}
