/**
 * Life tile keys whose geometry the worker still holds after leaving the view, so a tile that
 * returns (zooming back, panning back) is synchronized by identity instead of structured-cloning
 * its geometry again. The host and the worker each keep one and apply the same syncs in the same
 * order (Comlink preserves it), so they always agree on which keys are held.
 */
/** Tiles held beyond the current set. */
export const RETAINED_LIFE_TILES = 64;

export class RecentKeys {
  /** Least recently synchronized first. */
  private order: string[] = [];
  private held = new Set<string>();
  constructor(private readonly cap = RETAINED_LIFE_TILES) {}
  has(key: string) {
    return this.held.has(key);
  }
  /** Record a sync of `keys`; returns the keys no longer held. */
  touch(keys: readonly string[]): string[] {
    const now = new Set(keys);
    this.order = this.order.filter((key) => !now.has(key));
    this.order.push(...now);
    // The current keys, plus up to `cap` that have left.
    const evicted = this.order.splice(0, Math.max(0, this.order.length - this.cap - now.size));
    for (const key of now) this.held.add(key);
    for (const key of evicted) this.held.delete(key);
    return evicted;
  }
  clear() {
    this.order = [];
    this.held.clear();
  }
}
