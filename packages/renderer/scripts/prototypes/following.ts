/** Reusable scratch for the measured following prototype. */
import { FOLLOW } from '../../src/life/config';
import type { Mover } from '../../src/life/simulate';
import { VEHICLES } from '../../src/life/vehicles';

export class FollowingGroups {
  private readonly groups = new Map<number, number[]>();
  reset() {
    for (const indices of this.groups.values()) indices.length = 0;
    return this.groups;
  }
}

type Buckets = Map<number, Map<number, number[]>>;
const state = new WeakMap<readonly number[], Buckets>();
const BUCKET_METERS = 1;

/** Reverse progress order; retain exact overlap checks and the first index on equal progress. */
export function bucketFollow(
  group: readonly number[],
  progress: Float64Array,
  offsets: Float64Array,
  movers: readonly Mover[],
  speeds: Float64Array,
  perMeter: number,
) {
  let widths = state.get(group);
  if (!widths) state.set(group, (widths = new Map<number, Map<number, number[]>>()));
  for (const buckets of widths.values()) for (const indices of buckets.values()) indices.length = 0;
  // Buckets store sorted positions, not mover indices, to resolve ties exactly like the old loop.
  for (let k = group.length - 1; k >= 0; k--) {
    const i = group[k]!,
      me = VEHICLES[movers[i]!.vehicle!],
      offset = offsets[i]!;
    let leader = group.length;
    for (const [width, buckets] of widths) {
      const reach = (me.width + width) / 2 - FOLLOW.squeeze;
      if (reach <= 0) continue;
      const left = Math.floor((offset - reach) / BUCKET_METERS),
        right = Math.floor((offset + reach) / BUCKET_METERS);
      for (let b = left; b <= right; b++) {
        const indices = buckets.get(b);
        if (!indices) continue;
        for (let n = indices.length - 1; n >= 0; n--) {
          const at = indices[n]!;
          if (at >= leader) break;
          if (Math.abs(offset - offsets[group[at]!]!) < reach) {
            leader = at;
            break;
          }
        }
      }
    }
    if (leader < group.length) {
      const j = group[leader]!,
        them = VEHICLES[movers[j]!.vehicle!];
      const gap = progress[j]! - progress[i]! - (me.length + them.length) / 2;
      speeds[i] = Math.min(
        speeds[i]!,
        Math.max(0, (gap - FOLLOW.minGap) / FOLLOW.headway) * perMeter,
      );
    }
    let buckets = widths.get(me.width);
    if (!buckets) widths.set(me.width, (buckets = new Map<number, number[]>()));
    const b = Math.floor(offset / BUCKET_METERS);
    let indices = buckets.get(b);
    if (!indices) buckets.set(b, (indices = []));
    indices.push(k);
  }
}
