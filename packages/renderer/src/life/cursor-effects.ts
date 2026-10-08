import type { GridPlacement } from '../grid';

export type Ripple = readonly [x: number, y: number, age: number];
export const CURSOR_RIPPLES = { max: 4, cells: 2, seconds: 1.5 } as const;

/** Main-thread hover effects retain geographic anchors, never absolute float cells. */
export class CursorEffects {
  private rings: { at: readonly [number, number]; born: number }[] = [];
  private last?: readonly [number, number];
  clear() {
    this.rings.length = 0;
    this.last = undefined;
  }
  move(
    point: readonly [number, number],
    at: readonly [number, number],
    now: number,
    cell: { w: number; h: number },
  ) {
    if (
      !this.last ||
      Math.hypot((point[0] - this.last[0]) / cell.w, (point[1] - this.last[1]) / cell.h) >=
        CURSOR_RIPPLES.cells
    ) {
      this.last = [...point];
      this.rings.push({ at: [...at], born: now });
      if (this.rings.length > CURSOR_RIPPLES.max) this.rings.shift();
    }
  }
  active(now: number) {
    this.rings = this.rings.filter((ring) => now - ring.born < CURSOR_RIPPLES.seconds * 1000);
    return this.rings.length > 0;
  }
  project(grid: GridPlacement, now: number): Ripple[] {
    this.active(now);
    return this.rings.map((ring) => {
      const [x, y] = grid.toCell(...ring.at);
      return [x, y, (now - ring.born) / 1000];
    });
  }
}
