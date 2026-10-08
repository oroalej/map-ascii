import type { GridPlacement } from '../grid';
import type { CursorGust } from './pointer';
import { CURSOR_WIND, type CursorWind } from './cursor-wind';

export type Ripple = readonly [x: number, y: number, age: number];
export const CURSOR_RIPPLES = { max: 4, cells: 2, seconds: 1.5 } as const;

/** Main-thread hover effects retain geographic anchors, never absolute float cells. */
export class CursorEffects {
  private rings: { at: readonly [number, number]; born: number }[] = [];
  private last?: readonly [number, number];
  private sample?: { point: readonly [number, number]; time: number; scale: string };
  private moved = 0;
  private anchor?: readonly [number, number];
  private velocity: readonly [number, number] = [0, 0];
  private strength = 0;
  private direction: readonly [number, number] = [1, 0];
  clear() {
    this.rings.length = 0;
    this.last = undefined;
    this.sample = undefined;
    this.anchor = undefined;
    this.velocity = [0, 0];
    this.strength = 0;
  }
  rebase() {
    this.sample = undefined;
    this.velocity = [0, 0];
    this.strength = 0;
  }
  move(
    point: readonly [number, number],
    at: readonly [number, number],
    now: number,
    cell: { w: number; h: number },
    ripples = true,
  ) {
    this.anchor = at;
    const scale = `${cell.w}/${cell.h}`;
    const before = this.sample;
    if (!before || before.scale !== scale) {
      this.sample = { point: [...point], time: now, scale };
      this.moved = now;
      this.velocity = [0, 0];
      this.strength = 0;
    } else if (point[0] !== before.point[0] || point[1] !== before.point[1]) {
      const dt = Math.max(1, now - before.time);
      const blend = 1 - Math.exp(-dt / CURSOR_WIND.averageMs);
      const vx = ((point[0] - before.point[0]) * 1000) / dt;
      const vy = ((point[1] - before.point[1]) * 1000) / dt;
      const decay = Math.max(0, 1 - (now - this.moved) / CURSOR_WIND.decayMs);
      this.velocity = [
        this.velocity[0] * decay * (1 - blend) + vx * blend,
        this.velocity[1] * decay * (1 - blend) + vy * blend,
      ];
      const speed = Math.hypot(this.velocity[0] / cell.w, this.velocity[1] / cell.h);
      const length = Math.hypot(...this.velocity);
      if (length > 0) this.direction = [this.velocity[0] / length, this.velocity[1] / length];
      this.strength = Math.min(CURSOR_WIND.max, (speed / CURSOR_WIND.full) * CURSOR_WIND.max);
      this.sample = { point: [...point], time: now, scale };
      this.moved = now;
    }
    if (!ripples) {
      this.rings.length = 0;
      this.last = undefined;
      return;
    }
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
  rest(now: number) {
    return this.sample ? Math.max(0, now - this.moved) / 1000 : undefined;
  }
  gust(now: number, cellMeters: number): CursorGust | undefined {
    const strength = this.strength * Math.max(0, 1 - (now - this.moved) / CURSOR_WIND.decayMs);
    return this.anchor && strength > 0
      ? {
          lngLat: this.anchor,
          dir: this.direction,
          strength,
          radiusM: CURSOR_WIND.radius * cellMeters,
        }
      : undefined;
  }
  wind(grid: GridPlacement, now: number, aspect: number): CursorWind | undefined {
    const gust = this.gust(now, 1);
    if (!gust) return;
    const dir = [gust.dir[0], gust.dir[1] / aspect] as const;
    const length = Math.hypot(...dir);
    return {
      at: grid.toCell(...gust.lngLat),
      dir: [dir[0] / length, dir[1] / length],
      strength: gust.strength,
      radius: CURSOR_WIND.radius,
      aspect,
    };
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
