import { MAX_TILE_GATHERERS, SEASON_CROWD } from './config';
import { inTile, PLACE_STRIDE, type LifeGeometry } from './geometry';
import { memorialAnchors } from './seasonal-candles';
import { SHIRT_PAINTS, UMBRELLA_PAINTS } from './people';
import type { TileId } from '../tiles';
import type { Gatherer } from './simulate';
import type { SimulationSeason } from './seasonal-simulation';

type Admission = {
  tile: TileId;
  geo: LifeGeometry;
  perMeter: number;
  count: number;
  visitorsRng: () => number;
  congregationsRng: () => number;
  target: (owner: Gatherer) => void;
  guard: (owner: Gatherer) => boolean;
  remove: (owner: Gatherer) => void;
};

/** Complete visitor families reserve space first; congregations use remaining capacity. */
export function seasonalCrowds(config: SimulationSeason, admission: Admission): Gatherer[] {
  const { tile, geo, perMeter, target, guard, remove } = admission;
  const result: Gatherer[] = [];
  const capacity = () => MAX_TILE_GATHERERS - admission.count - result.length;
  const create = (
    seasonal: NonNullable<Gatherer['seasonal']>,
    cx: number,
    cy: number,
    inner: number,
    outer: number,
    source?: number,
  ) => {
    const rng = seasonal === 'visitors' ? admission.visitorsRng : admission.congregationsRng;
    const between = (range: readonly [number, number]) => range[0] + rng() * (range[1] - range[0]);
    const owner: Gatherer = {
      seasonal,
      source,
      place: 'worship',
      behavior: 'gather',
      cx,
      cy,
      inner,
      outer,
      x: cx,
      y: cy,
      hx: 1,
      hy: 0,
      tx: cx,
      ty: cy,
      speed: between(SEASON_CROWD.speed) * perMeter,
      pause: between(SEASON_CROWD.pause),
      walked: 0,
      rank: rng(),
      walker: {
        figure: 'adult',
        shirt: SHIRT_PAINTS[Math.floor(rng() * SHIRT_PAINTS.length)]!,
        umbrella: rng(),
        canopy: UMBRELLA_PAINTS[Math.floor(rng() * UMBRELLA_PAINTS.length)]!,
        lateral: 0,
        back: 0,
        step: rng() < 0.5 ? 0 : 1,
      },
      rx: 1,
      ry: 0,
      sign: 1,
    };
    for (let attempt = 0; attempt < 24; attempt++) {
      const angle = rng() * Math.PI * 2;
      const radius = Math.sqrt(inner * inner + rng() * (outer * outer - inner * inner));
      owner.x = cx + Math.cos(angle) * radius;
      owner.y = cy + Math.sin(angle) * radius;
      owner.hx = -Math.sin(angle);
      owner.hy = Math.cos(angle);
      if (inTile(owner) && guard(owner)) {
        target(owner);
        return owner;
      }
    }
    return undefined;
  };
  if (config.visitors) {
    const {
      share,
      per_grave_family: [minimum, maximum],
      max_per_tile,
    } = config.visitors;
    for (const site of memorialAnchors(tile, geo, share)) {
      const available = Math.min(capacity(), max_per_tile - result.length);
      if (available < minimum) break;
      const count = Math.min(
        available,
        minimum + Math.floor(admission.visitorsRng() * (maximum - minimum + 1)),
      );
      const family: Gatherer[] = [];
      for (let i = 0; i < count; i++) {
        const owner = create('visitors', site.x, site.y, perMeter, 2.5 * perMeter);
        if (owner) family.push(owner);
      }
      if (family.length >= minimum) result.push(...family);
      else family.forEach(remove);
    }
  }
  if (config.congregations) {
    for (const [index, landmark] of geo.placeLandmarks ?? []) {
      if (!config.congregations.landmarks.includes(landmark)) continue;
      const at = index * PLACE_STRIDE;
      const radius = geo.places[at + 3]!;
      const around = geo.places[at + 4] === 1;
      const inner = around ? radius + 1.5 * perMeter : 0;
      const outer = around ? inner + 8 * perMeter : radius * 0.85;
      for (let i = 0; i < config.congregations.extra && capacity() > 0; i++) {
        const owner = create(
          'congregations',
          geo.places[at]!,
          geo.places[at + 1]!,
          inner,
          outer,
          index,
        );
        if (owner) result.push(owner);
      }
    }
  }
  return result;
}
